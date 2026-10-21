import { Inject, Injectable, type BeforeApplicationShutdown } from "@nestjs/common";

export const LOG_STREAM_DETACH = Symbol("LOG_STREAM_DETACH");

/**
 * Holds the log stream's `detach` function, filled in after it exists (it needs the app's own HTTP
 * server, which is only available once the app itself has already been built). A plain mutable object
 * because Nest resolves providers once, at module registration time, before that is possible.
 */
export interface LogStreamDetachHolder {
  detach?: () => void;
}

/**
 * Closes every open log-stream WebSocket before Nest's HTTP adapter force-destroys sockets as part of
 * its own shutdown. `beforeApplicationShutdown` is the one hook Nest runs early enough for that: by the
 * time `OnApplicationShutdown` (used elsewhere for the scheduler and the database) runs, those sockets
 * are already gone.
 */
@Injectable()
export class LogStreamShutdown implements BeforeApplicationShutdown {
  constructor(@Inject(LOG_STREAM_DETACH) private readonly holder: LogStreamDetachHolder) {}

  beforeApplicationShutdown(): void {
    this.holder.detach?.();
  }
}
