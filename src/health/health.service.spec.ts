import { DataSource } from 'typeorm';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const makeService = (query: jest.Mock) => new HealthService({ query } as unknown as DataSource);

  it('reports ok with database up when SELECT 1 succeeds', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const result = await makeService(query).check();

    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('up');
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('reports degraded with database down when the query throws', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));
    const result = await makeService(query).check();

    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('down');
  });
});
