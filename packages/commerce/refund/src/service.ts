import type { Tx } from '@storeweave/contracts';
import { RefundRepository } from './repository';
const repository=new RefundRepository();
/** Shipping gets only this guard, never refund storage. */
export const refundShipmentGuard={hasBlockingDirectRefund(tx:Tx,orderId:string){return repository.hasBlockingDirectRefund(tx,orderId);}};
