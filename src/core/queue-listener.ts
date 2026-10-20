/** Something to tell that the queue changed. */
export interface QueueListener {
  kick(): void;
}
