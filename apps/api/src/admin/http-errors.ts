import { HttpException } from '@nestjs/common';
import { ServiceError } from './errors.js';

/** Traduce los errores de negocio de los servicios a respuestas HTTP. */
export async function toHttp<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ServiceError) throw new HttpException(err.message, err.status);
    throw err;
  }
}
