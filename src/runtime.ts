export interface RuntimeDaemon {
  start(signal: AbortSignal): Promise<void>;
}

export interface RuntimeWebhookServerHooks {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeDependencies {
  daemon: RuntimeDaemon;
  webhookServer: RuntimeWebhookServerHooks;
}

export class Runtime {
  private readonly abortController = new AbortController();
  private daemonPromise?: Promise<void>;

  constructor(private readonly deps: RuntimeDependencies) {}

  async start(): Promise<void> {
    this.daemonPromise = this.deps.daemon.start(this.abortController.signal);
    await this.deps.webhookServer.start();
  }

  async stop(): Promise<void> {
    await this.deps.webhookServer.stop();
    this.abortController.abort();

    if (this.daemonPromise !== undefined) {
      await this.daemonPromise;
    }
  }

  async run(stopSignal: AbortSignal): Promise<void> {
    await this.start();

    if (!stopSignal.aborted) {
      await new Promise<void>((resolve) => {
        stopSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    }

    await this.stop();
  }
}
