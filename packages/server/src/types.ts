/**
 * Wire-format shapes for HTTP request and response bodies.
 *
 * These mirror the core types from `@doctorchaos-ai/core`, but every
 * `Date` is replaced with an ISO 8601 `string`. That one substitution
 * is the whole reason these types exist: `JSON.stringify` would do the
 * right thing implicitly, but we want route handlers to compile-check
 * that the value they hand to `ctx.json` is in wire shape, not in
 * core shape.
 */

import type {
  CreationSource,
  Fragment,
  InboxSpace,
  Message,
  RoutingCorrection,
  RoutingMetadata,
  Role,
  TopicSpace,
  TopicStatus,
} from '@doctorchaos-ai/core';

// ─── Wire mirrors of core types ──────────────────────────────────────

export interface MessageWire {
  readonly id: string;
  readonly role: Role;
  readonly content: string;
  readonly timestamp: string;
  readonly routing?: RoutingMetadata;
}

export interface FragmentWire {
  readonly id: string;
  readonly messages: readonly MessageWire[];
  readonly timestamp: string;
  readonly keywords: readonly string[];
  readonly clusterHint?: string;
}

export interface TopicSpaceWire {
  readonly id: string;
  readonly name: string;
  readonly keywords: readonly string[];
  readonly createdDate: string;
  readonly lastActivityDate: string;
  readonly creationSource: CreationSource;
  readonly status: TopicStatus;
  readonly contextSummary?: string;
  readonly messages: readonly MessageWire[];
}

export interface InboxWire {
  readonly id: string;
  readonly fragments: readonly FragmentWire[];
  readonly totalMessageCount: number;
}

export interface RoutingCorrectionWire {
  readonly id: string;
  readonly messageId: string;
  readonly originalDestination: string;
  readonly correctedDestination: string;
  readonly timestamp: string;
  readonly messageContent: string;
}

// ─── Public HTTP request / response bodies ───────────────────────────

export interface SendMessageRequest {
  readonly role: Role;
  readonly content: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly idempotency_key?: string;
}

export interface RoutingDestinationWire {
  readonly kind: 'existingTopicSpace' | 'newTopicSpace' | 'inbox';
  readonly topicSpaceId?: string;
  readonly suggestedName?: string;
}

export interface RoutingDecisionWire {
  readonly destination: RoutingDestinationWire;
  readonly confidence: number;
  readonly reasoning: string;
}

export type SendMessageResponse =
  | {
      readonly destination: 'topicSpace';
      readonly space: TopicSpaceWire;
      readonly isNewSpace: boolean;
      readonly message: MessageWire;
      readonly decision: RoutingDecisionWire;
    }
  | {
      readonly destination: 'inbox';
      readonly inbox: InboxWire;
      readonly fragment: FragmentWire;
      readonly message: MessageWire;
      readonly decision: RoutingDecisionWire;
    };

export interface SpaceSummaryWire {
  readonly id: string;
  readonly name: string;
  readonly status: TopicStatus;
  readonly createdDate: string;
  readonly lastActivityDate: string;
  readonly keywords: readonly string[];
  readonly messageCount: number;
  readonly creationSource: CreationSource;
}

export interface ListSpacesResponse {
  readonly spaces: readonly SpaceSummaryWire[];
}

export interface CheckPackagingResponse {
  readonly createdSpaces: readonly TopicSpaceWire[];
}

export interface CheckLifecycleResponse {
  readonly changedSpaces: readonly TopicSpaceWire[];
}

export interface MoveMessageRequest {
  readonly to_space_id: string;
  readonly idempotency_key?: string;
}

// ─── Core → Wire converters ──────────────────────────────────────────
//
// One-way, deliberately explicit so the TS compiler catches any drift
// in core types. `fromWire` helpers are intentionally absent — the
// daemon only writes wire JSON out, never parses it back into core
// types (persistence layer handles that).

export function messageToWire(m: Message): MessageWire {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp.toISOString(),
    ...(m.routing !== undefined ? { routing: m.routing } : {}),
  };
}

export function fragmentToWire(f: Fragment): FragmentWire {
  return {
    id: f.id,
    messages: f.messages.map(messageToWire),
    timestamp: f.timestamp.toISOString(),
    keywords: f.keywords,
    ...(f.clusterHint !== undefined ? { clusterHint: f.clusterHint } : {}),
  };
}

export function topicSpaceToWire(s: TopicSpace): TopicSpaceWire {
  return {
    id: s.id,
    name: s.name,
    keywords: s.keywords,
    createdDate: s.createdDate.toISOString(),
    lastActivityDate: s.lastActivityDate.toISOString(),
    creationSource: s.creationSource,
    status: s.status,
    ...(s.contextSummary !== undefined ? { contextSummary: s.contextSummary } : {}),
    messages: s.messages.map(messageToWire),
  };
}

export function topicSpaceToSummaryWire(s: TopicSpace): SpaceSummaryWire {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    createdDate: s.createdDate.toISOString(),
    lastActivityDate: s.lastActivityDate.toISOString(),
    keywords: s.keywords,
    messageCount: s.messages.length,
    creationSource: s.creationSource,
  };
}

export function inboxToWire(i: InboxSpace): InboxWire {
  return {
    id: i.id,
    fragments: i.fragments.map(fragmentToWire),
    totalMessageCount: i.totalMessageCount,
  };
}

export function correctionToWire(c: RoutingCorrection): RoutingCorrectionWire {
  return {
    id: c.id,
    messageId: c.messageId,
    originalDestination: c.originalDestination,
    correctedDestination: c.correctedDestination,
    timestamp: c.timestamp.toISOString(),
    messageContent: c.messageContent,
  };
}
