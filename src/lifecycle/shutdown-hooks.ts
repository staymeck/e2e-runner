import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";

export const SHUTDOWN_CALLBACKS = Symbol("SHUTDOWN_CALLBACKS");

export type ShutdownCallback = () => void | Promise<void>;

/**
 * Runs the callbacks the composition root registered (stop the scheduler, close the database, ...)
 * one after the other, in order, when the app shuts down. A failing callback does not stop the rest.
 */
@Injectable()
export class ShutdownHooks implements OnApplicationShutdown {
  constructor(@Inject(SHUTDOWN_CALLBACKS) private readonly callbacks: readonly ShutdownCallback[]) {}

  async onApplicationShutdown(): Promise<void> {
    for (const callback of this.callbacks) {
      try {
        await callback();
      } catch {
        // one failing callback must not stop the others from running
      }
    }
  }
}
