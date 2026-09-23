export class ServiceError extends Error {
  constructor(service, status, permanent = false) {
    super(`${service} request failed${status ? ` (${status})` : ""}`);
    this.status = status;
    this.permanent = permanent;
    this.safeMessage = this.message;
  }
}
export async function request(url, options = {}, service = "External service") {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  } catch {
    throw new ServiceError(service);
  }
  if (!res.ok)
    throw new ServiceError(
      service,
      res.status,
      res.status >= 400 &&
        res.status < 500 &&
        ![408, 409, 429].includes(res.status),
    );
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    throw new ServiceError(service);
  }
}
