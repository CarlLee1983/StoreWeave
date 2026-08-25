import type { z } from 'zod';
import { PlatformError,defineQuery,type QueryContext } from '@storeweave/contracts';
import { customerService } from '@storeweave/customer';
import { getRmaInput,listRmasInput,listRmasOutput,rmaDto } from './dto';
import { RmaRepository,toRmaDto } from './repository';
const repository=new RmaRepository();
async function scopedCustomer(ctx:QueryContext){return ctx.actor.type==='customer'?customerService.customerIdOf(ctx.db,ctx.actor):null;}
export const getRmaQuery=defineQuery({name:'commerce.rma.getRma',summary:'取得退貨案件',input:getRmaInput,output:rmaDto,permission:'rma:read'});
export const getRmaHandler=async(input:z.infer<typeof getRmaInput>,ctx:QueryContext)=>{const customerId=await scopedCustomer(ctx);const row=await repository.findById(ctx.db,input.id);if(!row||(customerId!==null&&row.customerId!==customerId))throw PlatformError.notFound('RMA',input.id);return toRmaDto(row,await repository.linesFor(ctx.db,row.id));};
export const listRmasQuery=defineQuery({name:'commerce.rma.listRmas',summary:'列出退貨案件',input:listRmasInput,output:listRmasOutput,permission:'rma:read'});
export const listRmasHandler=async(input:z.infer<typeof listRmasInput>,ctx:QueryContext)=>repository.list(ctx.db,{...input,customerId:(await scopedCustomer(ctx))??undefined});
