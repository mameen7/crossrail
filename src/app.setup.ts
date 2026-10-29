import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { buildValidationPipe } from './common/validation.pipe';

export const API_PREFIX = 'api/v1';

/**
 * Applies the global prefix, the error envelope filter, the validation pipe
 * and Swagger. Shared by main.ts and the e2e harness so tests exercise the app
 * exactly as it is served.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(buildValidationPipe());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Crossrail')
      .setDescription('Stablecoin cross-border payments sandbox API')
      .setVersion('1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}
