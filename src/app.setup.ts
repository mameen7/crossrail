import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const API_PREFIX = 'api/v1';

/**
 * Applies the global prefix and Swagger setup. Shared by main.ts and the e2e
 * harness so tests exercise the app exactly as it is served.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);

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
