import {
  pgTable, bigserial, bigint, integer, text, uuid, timestamp,
} from 'drizzle-orm/pg-core';

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  totalSeats: integer('total_seats').notNull(),
  remaining: integer('remaining').notNull(),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reservations = pgTable('reservations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: bigint('event_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  quantity: integer('quantity').notNull(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
