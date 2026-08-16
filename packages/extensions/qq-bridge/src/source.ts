/**
 * Message-source abstraction: the bridge consumes any QQ transport that
 * implements this contract, so the official QQ bot gateway and the OneBot
 * (NapCat) transport can both plug in.
 *
 * @module @deepseek-ai/dsh-qq-bridge/source
 */

/** A normalized inbound private message. */
export interface SourceMessage {
  /** Sender identity: QQ user_openid (official) or QQ number (OneBot). */
  userId: string
  /** Plain text content. */
  text: string
  /** Message id, usable as the passive-reply reference where supported. */
  messageId?: string
  /** Ordering token for deduplication (repeated pushes share it). */
  seq?: string
}

/** Current transport connection state. */
export interface SourceStatus {
  /** 'connecting' | 'open' | 'closed' */
  state: string
  /** Human-readable detail (endpoint, close code, last error). */
  detail?: string
  /** Bot display name once READY, if the transport provides one. */
  botName?: string
  /** Milliseconds since the connection opened, when open. */
  uptimeMs?: number
}

/** One QQ message transport. */
export interface MessageSource {
  /**
   * Register an inbound private-message handler; returns its disposer.
   */
  onMessage(handler: (message: SourceMessage) => void | Promise<void>): () => void
  /**
   * Send one private message to one user.
   */
  send(userId: string, text: string): Promise<void>
  /**
   * Connect (or reconnect). Idempotent.
   */
  start(): void
  /**
   * Close permanently; no further reconnects.
   */
  stop(): void
  /**
   * Current connection state for the settings UI.
   */
  status(): SourceStatus
  /**
   * Register a status listener; returns its disposer. Fired on every change.
   */
  onStatus?(listener: (status: SourceStatus) => void): () => void
}
