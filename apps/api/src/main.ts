import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '2mb' }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 4100), '127.0.0.1');
}

void bootstrap();
