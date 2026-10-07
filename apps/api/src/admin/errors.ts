/** Error de negocio con el código HTTP que corresponde (los controladores lo traducen). */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
