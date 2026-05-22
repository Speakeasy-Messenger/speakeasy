import { SMALL_GROUP_MAX_MEMBERS, type GroupRepo, type GroupSummary } from './groups.js';

interface Group {
  createdBy: string;
  members: Set<string>;
  name: string | null;
}

export class InMemoryGroupRepo implements GroupRepo {
  readonly groups = new Map<string, Group>();

  async create(args: {
    groupId: string;
    createdBy: string;
    name?: string;
  }): Promise<void> {
    if (this.groups.has(args.groupId)) {
      throw new Error(`group ${args.groupId} already exists`);
    }
    this.groups.set(args.groupId, {
      createdBy: args.createdBy,
      members: new Set([args.createdBy]),
      name: args.name ?? null,
    });
  }

  async addMember(args: {
    groupId: string;
    userId: string;
    addedBy: string;
  }): Promise<number | 'group_full' | 'not_member' | 'group_missing'> {
    const g = this.groups.get(args.groupId);
    if (!g) return 'group_missing';
    if (!g.members.has(args.addedBy)) return 'not_member';
    if (g.members.has(args.userId)) return g.members.size;
    if (g.members.size >= SMALL_GROUP_MAX_MEMBERS) return 'group_full';
    g.members.add(args.userId);
    return g.members.size;
  }

  async isMember(groupId: string, userId: string): Promise<boolean> {
    return this.groups.get(groupId)?.members.has(userId) ?? false;
  }

  async countMembers(groupId: string): Promise<number> {
    return this.groups.get(groupId)?.members.size ?? 0;
  }

  async listMembers(groupId: string): Promise<string[]> {
    return Array.from(this.groups.get(groupId)?.members ?? []);
  }

  async removeMember(args: {
    groupId: string;
    userId: string;
  }): Promise<number | 'group_missing' | 'not_member' | 'cannot_remove_creator'> {
    const g = this.groups.get(args.groupId);
    if (!g) return 'group_missing';
    if (args.userId === g.createdBy) return 'cannot_remove_creator';
    if (!g.members.has(args.userId)) return 'not_member';
    g.members.delete(args.userId);
    return g.members.size;
  }

  async setName(args: {
    groupId: string;
    name: string;
  }): Promise<GroupSummary | 'group_missing'> {
    const g = this.groups.get(args.groupId);
    if (!g) return 'group_missing';
    g.name = args.name;
    return { id: args.groupId, createdBy: g.createdBy, name: g.name };
  }

  async leaveMember(args: {
    groupId: string;
    userId: string;
  }): Promise<
    | { members: number; createdBy: string | null; deleted: boolean }
    | 'group_missing'
    | 'not_member'
  > {
    const g = this.groups.get(args.groupId);
    if (!g) return 'group_missing';
    if (!g.members.has(args.userId)) return 'not_member';
    g.members.delete(args.userId);
    if (g.members.size === 0) {
      this.groups.delete(args.groupId);
      return { members: 0, createdBy: null, deleted: true };
    }
    if (g.createdBy === args.userId) {
      g.createdBy = Array.from(g.members)[0]!;
    }
    return { members: g.members.size, createdBy: g.createdBy, deleted: false };
  }

  async findById(groupId: string): Promise<GroupSummary | undefined> {
    const g = this.groups.get(groupId);
    if (!g) return undefined;
    return { id: groupId, createdBy: g.createdBy, name: g.name };
  }
}
