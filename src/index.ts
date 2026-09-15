export interface Env {
  KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  INVITE_CODE?: string;
  ADMIN_CHAT_ID?: string;
}

const worker = {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('should-i-work', { status: 200 });
  },
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // câblé à la Task 17
  },
} satisfies ExportedHandler<Env>;

export default worker;
