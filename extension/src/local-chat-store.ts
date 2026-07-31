import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { ChatSummaryData, ChatMessageData, SessionEvent } from './types/index';

export class LocalChatStore {
  private readonly chatsDir: string;

  constructor() {
    this.chatsDir = path.join(os.homedir(), '.vertex-swarm', 'chats');
  }

  private async ensureChatsDir(): Promise<void> {
    try {
      await fs.mkdir(this.chatsDir, { recursive: true });
    } catch (error) {
      // Ignore if directory already exists
    }
  }

  public async listChats(): Promise<ChatSummaryData[]> {
    await this.ensureChatsDir();
    let entries;
    try {
      entries = await fs.readdir(this.chatsDir, { withFileTypes: true });
    } catch (e) {
      return [];
    }

    const chats: ChatSummaryData[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(this.chatsDir, entry.name, 'meta.json');
        try {
          const metaContent = await fs.readFile(metaPath, 'utf8');
          const meta = JSON.parse(metaContent);
          chats.push({
            chatId: entry.name,
            title: meta.title || null,
            createdAt: meta.created_at || new Date().toISOString(),
            updatedAt: meta.updated_at || meta.created_at || new Date().toISOString(),
            ideContextEnabled: meta.ide_context_enabled || false
          });
        } catch (error) {
          // Skip directories without a valid meta.json
        }
      }
    }

    // Sort by updatedAt descending
    return chats.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  public async loadMessages(chatId: string): Promise<ChatMessageData[]> {
    const messagesPath = path.join(this.chatsDir, chatId, 'messages.jsonl');
    try {
      const content = await fs.readFile(messagesPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim() !== '');
      return lines.map(line => {
        const parsed = JSON.parse(line);
        return {
          messageId: parsed.message_id || parsed.id || crypto.randomUUID(),
          role: parsed.role || 'user',
          content: parsed.content || '',
          events: parsed.events || [],
          attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
          createdAt: parsed.created_at || parsed.timestamp || new Date().toISOString(),
          turn_duration_ms:
            typeof parsed.turn_duration_ms === 'number'
              ? parsed.turn_duration_ms
              : undefined,
        };
      });
    } catch (error) {
      // If messages file doesn't exist or is empty, return empty array
      return [];
    }
  }

  public async createChat(ideContextEnabled: boolean = false, title: string | null = null): Promise<string> {
    await this.ensureChatsDir();
    const chatId = crypto.randomUUID();
    const chatDir = path.join(this.chatsDir, chatId);
    
    await fs.mkdir(chatDir, { recursive: true });
    
    const now = new Date().toISOString();
    const meta = {
      title,
      created_at: now,
      updated_at: now,
      ide_context_enabled: ideContextEnabled
    };
    
    await fs.writeFile(path.join(chatDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    await fs.writeFile(path.join(chatDir, 'messages.jsonl'), '', 'utf8'); // Empty file to start
    
    return chatId;
  }

  public async updateIdeContext(chatId: string, enabled: boolean): Promise<void> {
    const metaPath = path.join(this.chatsDir, chatId, 'meta.json');
    try {
      const content = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(content);
      meta.ide_context_enabled = enabled;
      meta.updated_at = new Date().toISOString();
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (error) {
      console.error(`Failed to update IDE context for ${chatId}:`, error);
      throw new Error(`Chat metadata not found for ${chatId}`);
    }
  }

  public async loadSession(chatId: string): Promise<Record<string, unknown> | null> {
    const sessionPath = path.join(this.chatsDir, chatId, 'session.json');
    try {
      const content = await fs.readFile(sessionPath, 'utf8');
      const parsed = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  public async clearActiveToolCategories(chatId: string): Promise<void> {
    const session = await this.loadSession(chatId);
    if (!session) {
      return;
    }
    const workingMemory =
      session.working_memory && typeof session.working_memory === 'object'
        ? (session.working_memory as Record<string, unknown>)
        : null;
    if (!workingMemory || !Array.isArray(workingMemory.active_tool_categories)) {
      return;
    }
    workingMemory.active_tool_categories = [];
    await this.writeSession(chatId, session);
  }

  private async writeSession(chatId: string, session: Record<string, unknown>): Promise<void> {
    const sessionPath = path.join(this.chatsDir, chatId, 'session.json');
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  }

  public async getIdeContextEnabled(chatId: string): Promise<boolean> {
    const metaPath = path.join(this.chatsDir, chatId, 'meta.json');
    try {
      const content = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(content);
      return meta.ide_context_enabled || false;
    } catch (error) {
      return false;
    }
  }

  public async truncateMessages(chatId: string, messageId: string): Promise<{ sessionId: string, deletedCount: number }> {
    const messagesPath = path.join(this.chatsDir, chatId, 'messages.jsonl');
    try {
      const content = await fs.readFile(messagesPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim() !== '');
      
      const finalLines: string[] = [];
      let deletedCount = 0;
      let isTruncating = false;
      
      for (const line of lines) {
        const msg = JSON.parse(line);
        const msgId = msg.message_id || msg.id;
        
        // As soon as we find the message to truncate after, we start ignoring the rest
        if (msgId === messageId) {
          isTruncating = true;
        }
        
        if (isTruncating) {
          deletedCount++;
        } else {
          finalLines.push(line);
        }
      }
      
      const newContent = finalLines.length > 0 ? finalLines.join('\n') + '\n' : '';
      await fs.writeFile(messagesPath, newContent, 'utf8');
      
      return { sessionId: chatId, deletedCount };
    } catch (error) {
      console.error(`Failed to truncate messages for ${chatId}:`, error);
      throw new Error(`Failed to truncate messages for ${chatId}`);
    }
  }
}
