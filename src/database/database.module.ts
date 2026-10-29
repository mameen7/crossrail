import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './typeorm.config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...buildDataSourceOptions(), autoLoadEntities: true }),
    }),
  ],
})
export class DatabaseModule {}
