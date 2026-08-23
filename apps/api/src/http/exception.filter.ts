import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PlatformError, toPublicError } from '@storeweave/contracts';
import { correlationIdOf, type AuthenticatedRequest } from './auth';
import { RUNTIME, type Runtime } from '../tokens';

/**
 * 驗證失敗的細節可以回給呼叫端：它們講的是這次請求哪個欄位不對，不是伺服器的內部狀態。
 *
 * 其餘的 `details` 一律只進 log——`CONFLICT` 與 `INTERNAL_ERROR` 帶的是資料庫層的東西。
 * 沒有這一段，「輸入拒絕未知欄位」（ADR 0024）換來的是一個看不出要拿掉哪個鍵的 400，
 * 等於把一種沉默換成另一種。
 */
function validationDetails(error: PlatformError): { details?: unknown } {
  if (error.code !== 'VALIDATION_ERROR' || error.details === undefined) return {};
  return { details: error.details };
}

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
      void reply.status(exception.httpStatus).send({
        success: false,
        error: { code: exception.code, message: exception.message, ...validationDetails(exception) },
      });
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

    this.runtime.logger.error({ correlationId, error: (exception as Error)?.message, stack: (exception as Error)?.stack }, 'unhandled error');
    void reply.status(500).send({ success: false, error: toPublicError(exception) });
  }
}
