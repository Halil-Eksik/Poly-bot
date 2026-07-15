/** WebSocket client for Polymarket CLOB user channel — authenticated trade events. */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { WS_MSG_TRADE, WS_URL, WS_USER_PING_INTERVAL_S } from "../constants.js";

export type MsgCallback = (data: Record<string, unknown>) => Promise<void>;

const BACKOFF_BASE = 1.0;
const BACKOFF_MAX = 60.0;
const BACKOFF_JITTER = 0.5;
const MAX_AUTH_FAILURES = 3;
const SESSION_READY_TIMEOUT_S = 5.0;

export class UserWsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserWsAuthError";
  }
}

export class ClobWsCredentials {
  constructor(
    public readonly apiKey: string,
    public readonly apiSecret: string,
    public readonly apiPassphrase: string,
  ) {}

  valid(): boolean {
    return Boolean(
      (this.apiKey || "").trim() &&
        (this.apiSecret || "").trim() &&
        (this.apiPassphrase || "").trim(),
    );
  }
}

export function normalizeConditionId(conditionId: string): string {
  const cid = (conditionId || "").trim();
  if (cid.startsWith("0x") || cid.startsWith("0X")) {
    return "0x" + cid.slice(2).toLowerCase();
  }
  return cid;
}

function wsIsOpen(ws: WebSocket | null): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function randomUniform(min: number, max: number): number {
  const buf = randomBytes(4);
  const u32 = buf.readUInt32BE(0);
  const unit = u32 / 0xffffffff;
  return min + unit * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForMessage(
  ws: WebSocket,
  timeoutMs: number,
): Promise<WebSocket.RawData> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(data);
    };
    const onClose = () => {
      cleanup();
      reject(new UserWsAuthError("socket closed during auth handshake"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

function rawToString(raw: WebSocket.RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

/** Prefer API creds loaded on ClobClient (matches signing wallet), not stale .env alone. */
export function credentialsFromClobClient(
  clobClient: unknown | null | undefined,
): ClobWsCredentials | null {
  if (clobClient === null || clobClient === undefined) {
    return null;
  }
  const client = clobClient as Record<string, unknown>;
  let key = String(client.api_key ?? client.apiKey ?? "").trim();
  let secret = String(client.api_secret ?? client.apiSecret ?? "").trim();
  let passphrase = String(client.api_passphrase ?? client.apiPassphrase ?? "").trim();
  if (key && secret && passphrase) {
    return new ClobWsCredentials(key, secret, passphrase);
  }
  const inner = client._client as Record<string, unknown> | undefined;
  const creds = inner?.creds as Record<string, unknown> | undefined;
  if (!creds) {
    return null;
  }
  key = String(creds.api_key ?? creds.apiKey ?? "").trim();
  secret = String(creds.api_secret ?? creds.apiSecret ?? "").trim();
  passphrase = String(creds.api_passphrase ?? creds.apiPassphrase ?? "").trim();
  const auth = new ClobWsCredentials(key, secret, passphrase);
  return auth.valid() ? auth : null;
}

/** One-shot connect test; returns (ok, detail). */
export async function probeUserWsAuth(
  auth: ClobWsCredentials,
  options?: { wsUrl?: string; conditionId?: string },
): Promise<[boolean, string]> {
  if (!auth.valid()) {
    return [false, "missing api_key/secret/passphrase"];
  }
  const wsUrl = options?.wsUrl ?? WS_URL;
  const cid = options?.conditionId ? normalizeConditionId(options.conditionId) : "";
  const markets = cid ? [cid] : [];
  const endpoint = `${wsUrl.replace(/\/$/, "")}/ws/user`;
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve([true, "connected (no immediate server message)"]);
    }, SESSION_READY_TIMEOUT_S * 1000);

    ws.on("open", async () => {
      const initMsg: Record<string, unknown> = {
        type: "user",
        auth: {
          apiKey: auth.apiKey,
          secret: auth.apiSecret,
          passphrase: auth.apiPassphrase,
        },
      };
      if (markets.length > 0) {
        initMsg.markets = markets;
      }
      ws.send(JSON.stringify(initMsg));
    });

    ws.on("message", (raw) => {
      clearTimeout(timeout);
      const text = rawToString(raw).trim();
      if (text === "PONG" || text === "PING") {
        ws.close();
        resolve([true, "connected (heartbeat)"]);
        return;
      }
      try {
        const data: unknown = JSON.parse(text);
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const record = data as Record<string, unknown>;
          const err = record.error ?? record.message ?? record.errorMsg;
          if (err) {
            ws.close();
            resolve([false, String(err)]);
            return;
          }
        }
        ws.close();
        resolve([true, "connected"]);
      } catch {
        ws.close();
        resolve([true, `connected (non-json ack: ${text.slice(0, 120)})`]);
      }
    });

    ws.on("close", (code, reasonBuf) => {
      clearTimeout(timeout);
      const reason = reasonBuf.toString("utf8") || "none";
      resolve([false, `closed code=${code} reason=${reason}`]);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      resolve([false, String(err)]);
    });
  });
}

/** Authenticated user channel: trade events for subscribed condition IDs. */
export class ClobUserWebSocket {
  private readonly _wsUrl: string;
  private readonly _auth: ClobWsCredentials;
  private readonly _onTrade: MsgCallback | null;
  private readonly _pingIntervalS: number;
  private _markets: string[] = [];
  private _ws: WebSocket | null = null;
  private _listenAbort: AbortController | null = null;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _reconnectAttempt = 0;
  private _authFailures = 0;
  private _fatalAuthError: string | null = null;
  tradeMessagesReceived = 0;

  constructor(
    options: {
      wsUrl?: string;
      auth: ClobWsCredentials;
      onTrade?: MsgCallback | null;
      pingIntervalS?: number;
    },
  ) {
    this._wsUrl = (options.wsUrl ?? WS_URL).replace(/\/$/, "");
    this._auth = options.auth;
    this._onTrade = options.onTrade ?? null;
    this._pingIntervalS = Math.max(1.0, options.pingIntervalS ?? WS_USER_PING_INTERVAL_S);
  }

  get connected(): boolean {
    return wsIsOpen(this._ws);
  }

  get authFailed(): boolean {
    return this._fatalAuthError !== null;
  }

  async connect(conditionIds: string[]): Promise<void> {
    this._running = true;
    this._markets = conditionIds
      .map((c) => String(c).trim())
      .filter((c) => c.length > 0)
      .map(normalizeConditionId);
    await this._connectAndSubscribe();
    this._startPingLoop();
    void this._listenLoop();
    console.info(
      JSON.stringify({
        msg: "user_ws_connected",
        markets: this._markets.length,
        url: this._wsUrl,
      }),
    );
  }

  async disconnect(): Promise<void> {
    this._running = false;
    if (this._listenAbort) {
      this._listenAbort.abort();
      this._listenAbort = null;
    }
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (wsIsOpen(this._ws)) {
      this._ws!.close();
    }
    this._ws = null;
    console.info(
      JSON.stringify({
        msg: "user_ws_disconnected",
        trade_messages: this.tradeMessagesReceived,
      }),
    );
  }

  private async _connectAndSubscribe(): Promise<void> {
    const wsEndpoint = `${this._wsUrl}/ws/user`;
    const ws = new WebSocket(wsEndpoint);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    this._ws = ws;
    const initMsg: Record<string, unknown> = {
      type: "user",
      auth: {
        apiKey: this._auth.apiKey.trim(),
        secret: this._auth.apiSecret.trim(),
        passphrase: this._auth.apiPassphrase.trim(),
      },
    };
    if (this._markets.length > 0) {
      initMsg.markets = this._markets;
    }
    await this._send(initMsg);
    await this._waitSessionReady();
    this._reconnectAttempt = 0;
  }

  private async _waitSessionReady(): Promise<void> {
    if (!this._ws) {
      throw new UserWsAuthError("websocket not connected");
    }
    try {
      const raw = await waitForMessage(
        this._ws,
        SESSION_READY_TIMEOUT_S * 1000,
      );
      const text = rawToString(raw).trim();
      if (text === "PONG" || text === "PING") {
        return;
      }
      try {
        const data: unknown = JSON.parse(text);
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return;
        }
        const record = data as Record<string, unknown>;
        const err = record.error ?? record.message ?? record.errorMsg;
        if (err) {
          throw new UserWsAuthError(String(err));
        }
        await this._handlePayload(record);
      } catch (e) {
        if (e instanceof UserWsAuthError) {
          throw e;
        }
        return;
      }
    } catch (e) {
      if (e instanceof Error && e.message === "timeout") {
        if (wsIsOpen(this._ws)) {
          return;
        }
        throw new UserWsAuthError("socket closed during auth handshake");
      }
      if (e instanceof UserWsAuthError) {
        throw e;
      }
      throw new UserWsAuthError(String(e));
    }
  }

  private async _send(msg: Record<string, unknown>): Promise<void> {
    if (wsIsOpen(this._ws)) {
      this._ws!.send(JSON.stringify(msg));
    }
  }

  private _startPingLoop(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
    }
    this._pingTimer = setInterval(() => {
      if (!this._running || this._fatalAuthError) {
        return;
      }
      try {
        if (wsIsOpen(this._ws)) {
          this._ws!.send("PING");
        }
      } catch (e) {
        console.warn(JSON.stringify({ msg: "user_ws_ping_error", error: String(e) }));
      }
    }, this._pingIntervalS * 1000);
  }

  private async _listenLoop(): Promise<void> {
    while (this._running && !this._fatalAuthError) {
      try {
        await this._listen();
      } catch (e) {
        if (!this._running) {
          break;
        }
        if (e instanceof Error && e.name === "AbortError") {
          break;
        }
        console.warn(
          JSON.stringify({
            msg: "user_ws_connection_lost",
            error: String(e),
            attempt: this._reconnectAttempt,
          }),
        );
        await this._reconnect();
      }
    }
  }

  private async _onConnectionLost(code: number, reason: string): Promise<void> {
    console.warn(
      JSON.stringify({
        msg: "user_ws_connection_lost",
        close_code: code,
        close_reason: reason,
        attempt: this._reconnectAttempt,
      }),
    );
    if ([1006, 1008, 1002, 1003].includes(code) && this.tradeMessagesReceived === 0) {
      this._authFailures += 1;
    }
    if (this._authFailures >= MAX_AUTH_FAILURES) {
      this._fatalAuthError =
        "user WebSocket auth failed repeatedly (check CLOB API_KEY/SECRET/PASSPHRASE " +
        "match PRIVATE_KEY wallet; use derive_clob_api_creds or refresh API creds)";
      console.error(
        JSON.stringify({ msg: "user_ws_auth_giving_up", failures: this._authFailures }),
      );
      this._running = false;
      return;
    }
    await this._reconnect();
  }

  private async _handlePayload(data: Record<string, unknown>): Promise<void> {
    const eventType = String(data.event_type ?? "").toLowerCase();
    if (eventType === WS_MSG_TRADE && this._onTrade !== null) {
      this.tradeMessagesReceived += 1;
      try {
        await this._onTrade(data);
      } catch (e) {
        console.error(
          JSON.stringify({
            msg: "user_ws_callback_error",
            msg_type: eventType,
            error: String(e),
          }),
        );
      }
      return;
    }
    const err = data.error ?? data.message ?? data.errorMsg;
    if (err) {
      console.error(JSON.stringify({ msg: "user_ws_server_error", payload: data }));
    }
  }

  private _listen(): Promise<void> {
    if (!this._ws) {
      return Promise.resolve();
    }
    const ws = this._ws;
    this._listenAbort = new AbortController();
    const signal = this._listenAbort.signal;
    return new Promise((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData) => {
        void (async () => {
          const text = rawToString(raw);
          const stripped = text.trim();
          if (stripped === "PONG" || stripped === "PING") {
            return;
          }
          try {
            const data: unknown = JSON.parse(text);
            if (!data || typeof data !== "object" || Array.isArray(data)) {
              return;
            }
            await this._handlePayload(data as Record<string, unknown>);
          } catch (e) {
            if (e instanceof SyntaxError) {
              if (stripped) {
                console.debug(
                  JSON.stringify({ msg: "user_ws_non_json", sample: stripped.slice(0, 200) }),
                );
              }
              return;
            }
            reject(e);
          }
        })();
      };
      const onClose = (code: number, reasonBuf: Buffer) => {
        cleanup();
        if (!this._running) {
          resolve();
          return;
        }
        void this._onConnectionLost(code, reasonBuf.toString("utf8")).then(resolve).catch(reject);
      };
      const onError = (err: Error) => {
        cleanup();
        if (!this._running) {
          resolve();
          return;
        }
        reject(err);
      };
      const cleanup = () => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };
      signal.addEventListener("abort", onAbort);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    });
  }

  private async _reconnect(): Promise<void> {
    if (this._fatalAuthError) {
      return;
    }
    this._reconnectAttempt += 1;
    const delay = Math.min(
      BACKOFF_BASE * 2 ** (this._reconnectAttempt - 1),
      BACKOFF_MAX,
    );
    const wait = Math.max(0.1, delay + randomUniform(-BACKOFF_JITTER, BACKOFF_JITTER));
    console.info(
      JSON.stringify({
        msg: "user_ws_reconnecting",
        delay_s: Math.round(wait * 100) / 100,
        attempt: this._reconnectAttempt,
      }),
    );
    await sleep(wait * 1000);
    try {
      if (wsIsOpen(this._ws)) {
        this._ws!.close();
      }
    } catch {
      // ignore
    }
    try {
      await this._connectAndSubscribe();
      this._authFailures = 0;
      console.info(
        JSON.stringify({ msg: "user_ws_reconnected", attempt: this._reconnectAttempt }),
      );
    } catch (e) {
      if (e instanceof UserWsAuthError) {
        this._authFailures += 1;
        console.error(
          JSON.stringify({
            msg: "user_ws_auth_failed",
            error: String(e),
            failures: this._authFailures,
          }),
        );
        if (this._authFailures >= MAX_AUTH_FAILURES) {
          this._fatalAuthError = String(e);
          this._running = false;
        }
      } else {
        console.error(
          JSON.stringify({
            msg: "user_ws_reconnect_failed",
            error: String(e),
            attempt: this._reconnectAttempt,
          }),
        );
      }
    }
  }
}
