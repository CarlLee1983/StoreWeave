import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, toPublicError } from '@storeweave/contracts';
import { RUNTIME, type Runtime } from '../tokens';

/** 所有錯誤都轉成統一信封；內部細節只寫進 log。 */
@Catch()
export class PlatformExceptionFilter implements ExceptionFilter {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (exception instanceof PlatformError) {
      if (exception.httpStatus >= 500) {
        this.runtime.logger.error({ code: exception.code, message: exception.message, details: exception.details }, 'request failed');
      } else {
        this.runtime.logger.warn({ code: exception.code, message: exception.message }, 'request rejected');
      }
      void reply.status(exception.httpStatus).send({ success: false, error: { code: exception.code, message: exception.message } });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      void reply.status(status).send({
        success: false,
        error: { code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', message: exception.message },
      });
      return;
    }

    this.runtime.logger.error({ error: (exception as Error)?.message, stack: (exception as Error)?.stack }, 'unhandled error');
    void reply.status(500).send({ success: false, error: toPublicError(exception) });
  }
}
