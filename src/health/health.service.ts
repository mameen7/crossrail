import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HealthResponseDto } from './health.dto';

@Injectable()
export class HealthService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async check(): Promise<HealthResponseDto> {
    const database = await this.databaseIsUp();
    return {
      status: database ? 'ok' : 'degraded',
      checks: { database: database ? 'up' : 'down' },
      timestamp: new Date().toISOString(),
    };
  }

  private async databaseIsUp(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
