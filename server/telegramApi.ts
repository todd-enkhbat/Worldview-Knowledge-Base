/** The local connector uses Telegram's HTTPS Bot API; credentials never cross the app API. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024
export interface TelegramMedia { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number }
export interface TelegramMessage {
  message_id: number; date: number; edit_date?: number
  chat: { id: number; type: string; title?: string }
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string }
  text?: string; caption?: string; voice?: TelegramMedia; audio?: TelegramMedia; video?: TelegramMedia; video_note?: TelegramMedia; document?: TelegramMedia
  forward_origin?: Record<string, unknown>; message_thread_id?: number
}
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage }
export interface TelegramBot { id: number; username?: string; first_name?: string; is_bot?: boolean }
export class TelegramApiError extends Error {
  readonly status: number
  readonly retryAfter: number | null
  constructor(message: string, status = 502, retryAfter: number | null = null) { super(message); this.name = 'TelegramApiError'; this.status = status; this.retryAfter = retryAfter }
}
const validToken = (token: string) => /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)
export function validateTelegramToken(token: string): void { if (!validToken(token)) throw new TelegramApiError('Enter a valid bot token from BotFather, or set TELEGRAM_BOT_TOKEN on the local service.', 400) }
export class TelegramApi {
  private readonly token: string
  private readonly fetcher: typeof fetch
  constructor(token: string, fetcher: typeof fetch = fetch) { validateTelegramToken(token); this.token = token; this.fetcher = fetcher }
  async call<T>(method: 'getMe' | 'getWebhookInfo' | 'getUpdates' | 'getFile' | 'sendMessage', body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let response: Response
    try { response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000), redirect: 'error' }) }
    catch { if (signal?.aborted) throw new TelegramApiError('Telegram operation was cancelled.', 409); throw new TelegramApiError('Telegram could not be reached. Check the local service network connection.') }
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) throw new TelegramApiError('Telegram returned an oversized response.')
    let value: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } }
    try { value = JSON.parse(text) as typeof value } catch { throw new TelegramApiError('Telegram returned an invalid response.') }
    if (!response.ok || value.ok !== true || value.result === undefined) {
      const status = value.error_code ?? response.status
      throw new TelegramApiError(status === 401 ? 'Telegram rejected this bot token. Replace it in the local service configuration.' : status === 409 ? 'Another poller or webhook is already using this bot. Use a dedicated bot for this workspace.' : status === 429 ? 'Telegram rate-limited the connector. It will retry after the required delay.' : `Telegram ${method} failed (${status}).`, status === 401 ? 401 : status === 429 ? 429 : 502, typeof value.parameters?.retry_after === 'number' ? Math.min(3600, Math.max(1, value.parameters.retry_after)) : null)
    }
    return value.result
  }
  async download(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!fileId || fileId.length > 1024) throw new TelegramApiError('The Telegram attachment has no valid file identity.', 400)
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, signal)
    if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > TELEGRAM_DOWNLOAD_LIMIT)) throw new TelegramApiError('Telegram attachments above 20 MiB cannot be downloaded by this connector.', 413)
    const path = file.file_path
    if (!path || !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '..' || !part)) throw new TelegramApiError('Telegram returned an invalid attachment path.')
    let response: Response
    try { response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), redirect: 'error' }) }
    catch { throw new TelegramApiError(signal?.aborted ? 'Telegram download was cancelled.' : 'The Telegram original could not be downloaded. It remains pending for retry.', signal?.aborted ? 409 : 502) }
    if (!response.ok || !response.body) throw new TelegramApiError(`Telegram original download failed (${response.status}).`)
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > TELEGRAM_DOWNLOAD_LIMIT) { await response.body.cancel(); throw new TelegramApiError('Telegram attachments above 20 MiB are not supported.', 413) }
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.byteLength; if (size > TELEGRAM_DOWNLOAD_LIMIT) throw new TelegramApiError('Telegram original exceeded the 20 MiB download limit.', 413); chunks.push(chunk) }
    if (!size) throw new TelegramApiError('Telegram returned an empty original.')
    if (file.file_size !== undefined && size !== file.file_size) throw new TelegramApiError('Telegram original download was incomplete. It remains pending for retry.')
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  }
}
