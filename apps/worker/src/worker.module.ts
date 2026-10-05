import { Module } from '@nestjs/common';
import { ConversationRuntimeService } from './conversation-runtime.service.js';

@Module({
  providers: [ConversationRuntimeService],
})
export class WorkerModule {}
