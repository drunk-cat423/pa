import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelRoute, InboundMessage } from './channel-types.js';
import type { PrimaryPerson } from './memory-types.js';

export interface HarnessPolicy {
  version: 1;
  ownerBindings: { route: ChannelRoute; senderId: string }[];
  primaryPerson?: PrimaryPerson;
}

export const NO_OWNER_POLICY: HarnessPolicy = { version: 1, ownerBindings: [] };

export function validateHarnessPolicy(value: unknown): HarnessPolicy {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('ownerBindings' in value) || !Array.isArray(value.ownerBindings) || value.ownerBindings.length > 32) {
    throw new Error('harness policy 配置无效。');
  }
  function bindings(items: unknown[]): HarnessPolicy['ownerBindings'] { return items.map((binding: unknown) => {
    if (!binding || typeof binding !== 'object' || !('route' in binding) || !('senderId' in binding)) throw new Error('owner 身份配置无效。');
    const route = binding.route;
    if (!route || typeof route !== 'object' || !('channel' in route) || !('accountId' in route)
      || !('roomId' in route) || !('roomType' in route)
      || ![route.channel, route.accountId, route.roomId, binding.senderId].every(item => typeof item === 'string' && item.length > 0 && item.length <= 512)
      || !['group', 'private'].includes(String(route.roomType))) throw new Error('owner 身份配置无效。');
    return { route: { channel: route.channel as string, accountId: route.accountId as string,
      roomId: route.roomId as string, roomType: route.roomType as ChannelRoute['roomType'] }, senderId: binding.senderId as string };
  }); }
  const ownerBindings = bindings(value.ownerBindings);
  let primaryPerson: PrimaryPerson | undefined;
  if ('primaryPerson' in value) {
    const person = value.primaryPerson;
    if (!person || typeof person !== 'object' || !('id' in person) || typeof person.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(person.id) || !('bindings' in person) || !Array.isArray(person.bindings)
      || !person.bindings.length || person.bindings.length > 32) throw new Error('统一人物身份配置无效。');
    const parsed = bindings(person.bindings);
    const keys = parsed.map(binding => JSON.stringify([binding.route.channel, binding.route.accountId,
      binding.route.roomType, binding.route.roomId, binding.senderId]));
    if (new Set(keys).size !== keys.length) throw new Error('统一人物身份存在重复绑定。');
    primaryPerson = { id: person.id, bindings: parsed };
  }
  return { version: 1, ownerBindings, ...(primaryPerson ? { primaryPerson } : {}) };
}

export async function loadHarnessPolicy(dataDir: string): Promise<HarnessPolicy> {
  const path = join(dataDir, 'policy.json');
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return NO_OWNER_POLICY;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('policy.json 必须是有限大小的本地普通文件。');
  return validateHarnessPolicy(JSON.parse(await readFile(path, 'utf8')));
}

export function isMemoryOwner(policy: HarnessPolicy, message: InboundMessage): boolean {
  return policy.ownerBindings.some(binding => binding.senderId === message.senderId
    && binding.route.channel === message.route.channel && binding.route.accountId === message.route.accountId
    && binding.route.roomType === message.route.roomType && binding.route.roomId === message.route.roomId);
}

export function isPrimaryPerson(policy: HarnessPolicy, message: InboundMessage): boolean {
  return policy.primaryPerson?.bindings.some(binding => binding.senderId === message.senderId
    && binding.route.channel === message.route.channel && binding.route.accountId === message.route.accountId
    && binding.route.roomType === message.route.roomType && binding.route.roomId === message.route.roomId) ?? false;
}
