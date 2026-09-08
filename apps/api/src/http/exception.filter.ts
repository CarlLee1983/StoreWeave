import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, toPublicError } from '@storeweave/contracts';
import { correlationIdOf, type AuthenticatedRequest } from './auth';
import { RUNTIME, type Runtime } from '../tokens';
import { httpError } from './envelope';

/** 所有錯誤都轉成統一信封；內部細節只寫進 log。 */
@Catch()
export class PlatformExceptionFilter implements ExceptionFilter {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    // Bus 那一行有 latencyMs 與 command / query 的名字卻沒有 message，這一行相反。
    // 少了 correlationId，排查時只能靠時間戳把兩行湊在一起（工單 53 的審查發現）。
    const correlationId = correlationIdOf(http.getRequest<AuthenticatedRequest>());

    if (exception instanceof PlatformError) {
      if (exception.httpStatus >= 500) {
        this.runtime.logger.error({ correlationId, code: exception.code, message: exception.message, details: exception.details }, 'request failed');
      } else {
        this.runtime.logger.warn({ correlationId, code: exception.code, message: exception.message, details: exception.details }, 'request rejected');
      }
      void reply.status(exception.httpStatus).send(httpError(exception));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      void reply.status(status).send(httpError({ code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', message: exception.message }));
      return;
    }

    this.runtime.logger.error({ correlationId, error: (exception as Error)?.message, stack: (exception as Error)?.stack }, 'unhandled error');
    void reply.status(500).send(httpError(toPublicError(exception)));
  }
}
