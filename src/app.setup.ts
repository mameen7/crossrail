import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { buildValidationPipe } from './common/validation.pipe';

export const API_PREFIX = 'api/v1';

/**
 * Applies the global prefix, the error envelope filter, the validation pipe
 * and Swagger. Shared by main.ts, the e2e harness and `yarn openapi`, so tests
 * exercise the app exactly as it is served and the committed openapi.json is
 * the document served at /docs-json. Returns that document.
 */
export function configureApp(app: INestApplication): OpenAPIObject {
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
  return document;
}
