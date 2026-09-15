/**
 * Hand-maintained declarations for the bindings and variables this app reads.
 *
 * Deliberately not generated: `wrangler types` produces a much larger file that
 * does not know about the Worker *secrets* (APP_ENCRYPTION_KEY, AUTH_SECRET,
 * the OAuth client secrets, ...) — it only sees what `wrangler.jsonc` declares,
 * so its output would be less accurate than this. It also refuses to overwrite
 * this file unless you rename it first.
 *
 * When you add a binding or a variable, declare it here too.
 */
interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}

interface D1Database {
	prepare(query: string): D1PreparedStatement;
	exec(query: string): Promise<unknown>;
	batch<T>(statements: D1PreparedStatement[]): Promise<T[]>;
}

interface R2Bucket {
	get(
		key: string,
		options?: { range?: { offset?: number; length?: number } }
	): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null>;
	head(key: string): Promise<{ size: number } | null>;
	put(
		key: string,
		value: ArrayBuffer | ArrayBufferView | string | Blob,
		options?: { httpMetadata?: { contentType?: string } }
	): Promise<unknown>;
	delete(key: string): Promise<void>;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

interface IncomingRequestCfProperties {
	[key: string]: unknown;
}

interface Env {
	DB: D1Database;
	MEDIA: R2Bucket;
	/** Optional Cloudflare Queue: with it bound, the tick hands publishes to the
	 *  consumer instead of publishing inline. Off by default (see wrangler.jsonc). */
	PUBLISH_QUEUE?: Queue;
	ASSETS: { fetch: typeof fetch };
	APP_URL?: string;
	/** Instance display name shown in the UI. Defaults to "SocialSent". */
	APP_NAME?: string;
	APP_ENCRYPTION_KEY: string;
	AUTH_SECRET: string;
	ADMIN_EMAIL: string;
	ADMIN_PASSWORD: string;
	SCHEDULER_SECRET?: string;
	API_TOKEN?: string;
	RESEND_API_KEY?: string;
	NOTIFY_EMAIL?: string;
	NOTIFY_FROM?: string;
	MEDIA_PUBLIC_BASE_URL?: string;
	LINKEDIN_CLIENT_ID?: string;
	LINKEDIN_CLIENT_SECRET?: string;
	THREADS_APP_ID?: string;
	THREADS_APP_SECRET?: string;
	X_CLIENT_ID?: string;
	X_CLIENT_SECRET?: string;
	/** Local-dev only: skips 2FA. Honored for localhost APP_URLs in dev builds. */
	SKIP_TOTP?: string;
	/** Set to "1" to let a Cloudflare cron trigger run the tick (see README →
	 *  Scheduling). scripts/wrap-worker.mjs no-ops the scheduled handler without
	 *  it, so an old cron cannot fire twice while you migrate. */
	ENABLE_CF_CRON?: string;
}

interface Queue<Body = unknown> {
	send(body: Body): Promise<void>;
}

interface Message<Body = unknown> {
	body: Body;
	ack(): void;
	retry(): void;
}

interface MessageBatch<Body = unknown> {
	messages: Message<Body>[];
	queue: string;
}
