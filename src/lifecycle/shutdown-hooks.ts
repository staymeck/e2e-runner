import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";

export const SHUTDOWN_CALLBACKS = Symbol("SHUTDOWN_CALLBACKS");

/** Runs the callbacks the composition root registered (closing the database, ...) when the app shuts down. */
@Injectable()
export class ShutdownHooks implements OnApplicationShutdown {
  constructor(@Inject(SHUTDOWN_CALLBACKS) private readonly callbacks: readonly (() => void)[]) {}

  onApplicationShutdown(): void {
    for (const callback of this.callbacks) {
      try {
        callback();
      } catch {
        // one failing callback must not stop the others from running
      }
    }
  }
}
