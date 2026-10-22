import { STATUS_CODES } from "node:http";
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { Response } from "express";
import { CatalogUnsupportedError, ProjectHasNoDevicesError, UnknownProjectError } from "../core/adapter";
import { DIAGNOSTICS, type Diagnostics } from "../core/diagnostics";
import { InvalidTransitionError, JobAlreadyFinishedError, JobNotFoundError, RetryNotAllowedError } from "../core/job";
import { CatalogReadError, InvalidJobRequestError, RefNotAllowedError, RefNotFoundError } from "../core/job-request";

interface Mapping {
  readonly type: new (...args: never[]) => Error;
  readonly status: HttpStatus;
  readonly code: string;
}

/** The status each domain error becomes. Anything not listed is a 500 with no detail. */
const MAPPINGS: readonly Mapping[] = [
  { type: InvalidJobRequestError, status: HttpStatus.BAD_REQUEST, code: "invalid_request" },
  { type: RefNotAllowedError, status: HttpStatus.FORBIDDEN, code: "ref_not_allowed" },
  { type: UnknownProjectError, status: HttpStatus.NOT_FOUND, code: "unknown_project" },
  { type: CatalogUnsupportedError, status: HttpStatus.NOT_FOUND, code: "catalog_unsupported" },
  { type: ProjectHasNoDevicesError, status: HttpStatus.NOT_FOUND, code: "no_devices" },
  { type: JobNotFoundError, status: HttpStatus.NOT_FOUND, code: "job_not_found" },
  { type: RefNotFoundError, status: HttpStatus.UNPROCESSABLE_ENTITY, code: "ref_not_found" },
  { type: CatalogReadError, status: HttpStatus.UNPROCESSABLE_ENTITY, code: "catalog_unavailable" },
  { type: JobAlreadyFinishedError, status: HttpStatus.CONFLICT, code: "job_finished" },
  { type: RetryNotAllowedError, status: HttpStatus.CONFLICT, code: "retry_not_allowed" },
  { type: InvalidTransitionError, status: HttpStatus.CONFLICT, code: "invalid_transition" },
  // InvalidDetailsError is deliberately absent: it means the service itself passed bad data, a bug to log (500).
];

/** The `type` the body parser (`body-parser`/`http-errors`) gives its errors; only these are treated as the client's fault. */
const BODY_ERRORS: Readonly<Record<string, { status: number; code: string; message: string }>> = {
  "entity.too.large": { status: 413, code: "payload_too_large", message: "Request body too large" },
  "entity.parse.failed": { status: 400, code: "invalid_request", message: "Malformed request body" },
  "encoding.unsupported": { status: 415, code: "invalid_request", message: "Unsupported encoding" },
  "charset.unsupported": { status: 415, code: "invalid_request", message: "Unsupported charset" },
  "request.aborted": { status: 400, code: "invalid_request", message: "Request aborted" },
  "request.size.invalid": { status: 400, code: "invalid_request", message: "Invalid request size" },
};

function bodyErrorOf(candidate: unknown): { status: number; code: string; message: string } | undefined {
  const type = (candidate as { type?: unknown } | null)?.type;
  return typeof type === "string" && Object.hasOwn(BODY_ERRORS, type) ? BODY_ERRORS[type] : undefined;
}

/**
 * Errors raised by the body parser before a controller runs, either as they are or wrapped by Nest in a
 * BadRequestException (then the parser's error is its `cause`). Matched by the parser's own error type,
 * not by a `status` field: any library error may carry one and must not pass as the client's fault.
 */
function clientError(exception: unknown): { status: number; code: string; message: string } | undefined {
  return bodyErrorOf(exception) ?? bodyErrorOf((exception as { cause?: unknown } | null)?.cause);
}

/**
 * Nest's own HTTP exceptions. Not `instanceof`: the HTTP adapter is loaded as an ES module with its own
 * copy of `@nestjs/common`, so the exceptions it throws are not instances of the copy this code imports.
 */
function isHttpException(exception: unknown): exception is HttpException {
  const candidate = exception as { getStatus?: unknown; message?: unknown } | null;
  return typeof candidate?.getStatus === "function" && typeof candidate.message === "string";
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(@Inject(DIAGNOSTICS) private readonly diagnostics: Diagnostics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    const client = clientError(exception);
    if (client) {
      response.status(client.status).json({ statusCode: client.status, error: client.code, message: client.message });
      return;
    }
    if (isHttpException(exception)) {
      const status = exception.getStatus();
      if (status === HttpStatus.UNAUTHORIZED) response.setHeader("WWW-Authenticate", "Bearer");
      // Only our own 401 text is shown; the rest is the standard reason, never what the framework or the parser wrote
      // (those messages can quote the request).
      const message = status === HttpStatus.UNAUTHORIZED ? exception.message : (STATUS_CODES[status] ?? "Error");
      response.status(status).json({ statusCode: status, error: HttpStatus[status]?.toLowerCase() ?? "error", message });
      return;
    }
    const mapping = MAPPINGS.find((candidate) => exception instanceof candidate.type);
    if (mapping && exception instanceof Error) {
      response.status(mapping.status).json({ statusCode: mapping.status, error: mapping.code, message: exception.message });
      return;
    }
    // Unexpected: the cause goes to the log, never to the client.
    this.diagnostics.error({ error: exception instanceof Error ? (exception.stack ?? exception.message) : String(exception) }, "unhandled error in a request");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, error: "internal_error", message: "Internal server error" });
  }
}
