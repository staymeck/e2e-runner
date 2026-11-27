import { api, errorMessage } from "./client";

/**
 * Fetches the report as a blob (it needs our own Authorization, a plain link cannot carry one) and
 * opens it in a new tab. The tab is opened synchronously, on the click itself, with nothing in it yet
 * — popup blockers key off that synchronous "user activation" moment, and opening it only after the
 * `await fetch` below (found by review) loses it, so the tab is silently blocked whenever the fetch
 * takes any real time at all. It is then pointed at the blob once the fetch resolves, instead.
 *
 * Deliberately never revokes the blob URL: the tab keeps using it for as long as it stays open (it
 * may well still be loading embedded screenshots/video from the Detox report when this call returns),
 * and there is no reliable, synchronous "the tab is done with it now" signal across tabs to revoke on.
 * The cost is one held blob per report a person actually opens in this browser tab's lifetime — opened
 * by a human clicking a button, not in a loop, so this never grows unbounded in practice.
 *
 * Shared by HistorialPage's job-detail view (JobLogPage) and StatusPage — both open a job's own
 * report the same way, so this lives in one place instead of being copied.
 */
export function openReport(jobId: string, onError: (message: string) => void): void {
  const tab = window.open("", "_blank");
  if (!tab) {
    onError("El navegador bloqueó la ventana nueva: permite ventanas emergentes para este sitio.");
    return;
  }
  api.jobs
    .reportUrl(jobId)
    .then((url) => {
      tab.location.href = url;
    })
    .catch((err) => {
      tab.close();
      onError(errorMessage(err));
    });
}
