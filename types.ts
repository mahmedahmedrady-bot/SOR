
export interface User {
  id: string;
  username: string;
  password?: string;
  points: number;
  isPro: boolean;
  plan: 'free' | 'basic' | 'advanced' | 'unlimited';
  avatar?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  type?: 'text' | 'image';
  imageUrl?: string;
  groundingUrls?: {uri: string, title: string}[];
}

export interface ChatSession {
  id: string;
  userId: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  category?: string;
}
