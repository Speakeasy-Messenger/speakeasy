import { SMALL_GROUP_MAX_MEMBERS, type GroupRepo, type GroupSummary } from './groups.js';

interface Group {
  createdBy: string;
  members: Set<string>;
  avatarB64?: string;
}

export class InMemoryGroupRepo implements GroupRepo {
  readonly groups = new Map<string, Group>();

  async create(args: { groupId: string; createdBy: string }): Promise<void> {
    if (this.groups.has(args.groupId)) {
      throw new Error(`group ${args.groupId} already exists`);
    }
    this.groups.set(args.groupId, {
      createdBy: args.createdBy,
      members: new Set([args.createdBy]),
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

  async findById(groupId: string): Promise<GroupSummary | undefined> {
    const g = this.groups.get(groupId);
    if (!g) return undefined;
    return { id: groupId, createdBy: g.createdBy, avatarB64: g.avatarB64 };
  }

  async setAvatar(groupId: string, avatarB64: string | undefined): Promise<void> {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.avatarB64 = avatarB64;
  }
}
