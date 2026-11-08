/** Stand-in for the `cloudflare:workers` module, which only exists inside workerd. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}
