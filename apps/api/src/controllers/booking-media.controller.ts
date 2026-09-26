import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PlatformError, type Actor } from '@storeweave/contracts';
import { Anonymous } from '../http/auth';
import { HttpContract } from '../http/contract';
import { RUNTIME, type Runtime } from '../tokens';

const publicReader: Actor = {
  id: 'http:booking-media', type: 'service', displayName: 'Booking media visitor',
  permissions: ['booking-property:public-read'],
};
const previewRoute = {
  kind: 'direct', request: 'none',
  input: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } }, additionalProperties: false },
  output: 'binary',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Anonymous()
@Controller('booking/media')
export class BookingMediaController {
  constructor(@Inject(RUNTIME) private readonly runtime: Runtime) {}

  @Get(':id/preview')
  @HttpContract(previewRoute)
  async preview(@Req() request: FastifyRequest, @Res() reply: FastifyReply, @Param('id') id: string) {
    if (!UUID.test(id)) throw PlatformError.notFound('Booking media', id);
    await this.runtime.queries.execute('booking.property.getPublicMedia', { mediaAssetId: id }, {
      actor: publicReader, channel: 'rest',
    });
    const opened = await this.runtime.media.openPreview(id);
    reply.header('content-type', opened.object.contentType);
    reply.header('content-length', String(opened.object.byteSize));
    reply.header('content-disposition', 'inline');
    // Recheck the live Room Type reference on every request, including after deactivation.
    reply.header('cache-control', 'no-store');
    request.raw.once('close', () => opened.content.destroy());
    return reply.send(opened.content);
  }
}
