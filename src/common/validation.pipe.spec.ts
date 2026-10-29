import { ValidationError } from '@nestjs/common';
import { IsEmail, IsOptional } from 'class-validator';
import { ApiError } from './api-error';
import { buildValidationPipe, flattenValidationErrors } from './validation.pipe';

class Dto {
  @IsOptional()
  @IsEmail()
  email?: string;
}

describe('flattenValidationErrors', () => {
  it('produces one row per property with its constraint messages, nested paths dotted', () => {
    const errors: ValidationError[] = [
      { property: 'email', constraints: { isEmail: 'email must be an email' }, children: [] },
      {
        property: 'address',
        children: [{ property: 'city', constraints: { isString: 'city must be a string' } }],
      },
    ];
    expect(flattenValidationErrors(errors)).toEqual([
      { field: 'email', messages: ['email must be an email'] },
      { field: 'address.city', messages: ['city must be a string'] },
    ]);
  });
});

describe('buildValidationPipe', () => {
  const pipe = buildValidationPipe();
  const metadata = { type: 'body' as const, metatype: Dto, data: undefined };

  it('throws a 422 VALIDATION_ERROR ApiError with field details', async () => {
    await expect(pipe.transform({ email: 'nope' }, metadata)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'email', messages: ['email must be an email'] }],
    });
    await expect(pipe.transform({ email: 'nope' }, metadata)).rejects.toBeInstanceOf(ApiError);
    await expect(pipe.transform({ email: 'nope' }, metadata)).rejects.toHaveProperty('status', 422);
  });

  it('strips properties that the DTO does not declare', async () => {
    const result: unknown = await pipe.transform({ email: 'a@b.co', extra: 1 }, metadata);
    expect(result).toBeInstanceOf(Dto);
    expect(result).toEqual({ email: 'a@b.co' });
  });
});
