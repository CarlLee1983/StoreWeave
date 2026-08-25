import type { z } from 'zod';
import { PlatformError,defineQuery,type QueryContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { getRefundInput,listRefundsInput,listRefundsOutput,refundOutputDto } from './dto';
import { RefundRepository,toCustomerRefundDto,toRefundDto } from './repository';
const repository=new RefundRepository();
async function customerId(ctx:QueryContext){return ctx.actor.type==='customer'?customerService.customerIdOf(ctx.db,ctx.actor):null;}
export const getRefundQuery=defineQuery({name:'commerce.refund.getRefund',summary:'取得退款紀錄',input:getRefundInput,output:refundOutputDto,permission:'refund:read'});
export const getRefundHandler=async(input:z.infer<typeof getRefundInput>,ctx:QueryContext)=>{const row=await repository.findById(ctx.db,input.id);const id=await customerId(ctx);if(!row||(id!==null&&row.customerId!==id))throw PlatformError.notFound('Refund',input.id);return id!==null?toCustomerRefundDto(row):toRefundDto(row);};
export const listRefundsQuery=defineQuery({name:'commerce.refund.listRefunds',summary:'列出退款作業隊列',input:listRefundsInput,output:listRefundsOutput,permission:'refund:read'});
export const listRefundsHandler=async(input:z.infer<typeof listRefundsInput>,ctx:QueryContext)=>{const id=await customerId(ctx);const {rows,total}=await repository.list(ctx.db,{...input,customerId:id??undefined});return{items:id!==null?rows.map(toCustomerRefundDto):rows.map(toRefundDto),total};};
