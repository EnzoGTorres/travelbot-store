export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export class HttpRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

function extractErrorMessage(data: unknown, fallbackMessage: string): string {
  if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string") {
    return data.message;
  }

  if (typeof data === "string" && data.trim()) {
    return data.trim();
  }

  return fallbackMessage;
}

function extractErrorDetail(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (typeof data === "object" && data !== null) {
    return JSON.stringify(data);
  }

  return undefined;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return JSON.parse(text) as unknown;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function requestJson<T>(
  input: string | URL,
  options?: JsonRequestOptions
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs;
  const timeoutHandle =
    typeof timeoutMs === "number"
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

  try {
    const headers: Record<string, string> = {
      ...(options?.headers ?? {})
    };

    let body: string | undefined;

    if (options?.body !== undefined) {
      body = JSON.stringify(options.body);

      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }

    const response = await fetch(input, {
      method: options?.method ?? "GET",
      headers,
      body,
      signal: controller.signal
    });
    const data = await parseResponseBody(response);

    if (!response.ok) {
      throw new HttpRequestError(
        extractErrorMessage(data, `${response.status} ${response.statusText}`),
        response.status,
        extractErrorDetail(data)
      );
    }

    return data as T;
  } catch (error: unknown) {
    if (error instanceof HttpRequestError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpRequestError(
        typeof timeoutMs === "number"
          ? `La solicitud excedio el timeout de ${timeoutMs}ms.`
          : "La solicitud fue cancelada."
      );
    }

    if (error instanceof Error) {
      throw new HttpRequestError(error.message);
    }

    throw new HttpRequestError("La solicitud HTTP fallo por un error desconocido.");
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
