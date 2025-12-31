
import React, { useState, useEffect, useRef } from 'react';
import { 
  LogOut,
  Sparkles,
  Menu
} from 'lucide-react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import Auth from './components/Auth';
import SubscriptionModal from './components/SubscriptionModal';
import { ChatSession, Message, User } from './types';
import { getSorResponseStream, generateSorImage } from './services/geminiService';
import { Storage } from './services/storage';

const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 768);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [mode, setMode] = useState<'chat' | 'image' | 'search'>('chat');
  const [isSubModalOpen, setIsSubModalOpen] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [guestUsed, setGuestUsed] = useState(() => {
    return localStorage.getItem('sor_guest_used') === 'true';
  });

  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const initApp = async () => {
      const loggedUser = Storage.getCurrentUser();
      if (loggedUser) {
        const freshUserData = await Storage.findUser(loggedUser.username, loggedUser.password);
        if (freshUserData) {
          setUser(freshUserData);
          Storage.setCurrentUser(freshUserData);
          const userSessions = await Storage.getSessions(freshUserData.id);
          setSessions(userSessions);
        } else {
          Storage.setCurrentUser(null);
        }
      }
    };
    initApp();

    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = () => {
    Storage.setCurrentUser(null);
    setUser(null);
    setSessions([]);
    setCurrentSessionId(null);
    setGuestUsed(localStorage.getItem('sor_guest_used') === 'true');
    setShowUserMenu(false);
  };

  const handleUpgrade = async (plan: User['plan'], extraPoints: number) => {
    if (!user) return;
    const updatedUser: User = { 
      ...user, 
      plan, 
      points: plan === 'unlimited' ? 9999999 : (user.points + extraPoints) 
    };
    setUser(updatedUser);
    await Storage.saveUser(updatedUser);
    setIsSubModalOpen(false);
    alert("مبروك! تم تفعيل اشتراكك في Sor بنجاح.");
  };

  const handleSendMessage = async (text: string, fileData?: { data: string, mimeType: string }) => {
    if ((!text.trim() && !fileData) || isGenerating) return;

    if (!user) {
      if (guestUsed) {
        setShowAuthModal(true);
        return;
      }
    } else {
      const cost = mode === 'image' ? 20 : (fileData ? 10 : 5);
      if (user.plan !== 'unlimited' && user.points < cost) {
          setIsSubModalOpen(true);
          return;
      }
    }

    let targetSessionId = currentSessionId;
    let currentSession: ChatSession;

    if (!targetSessionId) {
      currentSession = {
        id: generateUUID(),
        userId: user?.id || 'guest',
        title: text.slice(0, 30) || "محادثة ضيف",
        messages: [],
        updatedAt: Date.now(),
        category: mode
      };
      targetSessionId = currentSession.id;
      setSessions(prev => [currentSession, ...prev]);
      setCurrentSessionId(targetSessionId);
    } else {
      currentSession = sessions.find(s => s.id === targetSessionId)!;
    }

    const userMessage: Message = {
      id: generateUUID(),
      role: 'user',
      content: text || (fileData ? "تم رفع ملف للتحليل" : ""),
      timestamp: Date.now()
    };

    const updatedSessionWithUserMsg = {
        ...currentSession,
        messages: [...currentSession.messages, userMessage],
        updatedAt: Date.now()
    };
    
    await updateSessionState(updatedSessionWithUserMsg);
    setIsGenerating(true);

    try {
      if (mode === 'image' && user) {
        const url = await generateSorImage(text);
        const assistantMsg: Message = {
            id: generateUUID(),
            role: 'assistant',
            content: "تم إنشاء الصورة بنجاح بواسطة Sor.",
            timestamp: Date.now(),
            type: 'image',
            imageUrl: url
        };
        await updateSessionState({
            ...updatedSessionWithUserMsg,
            messages: [...updatedSessionWithUserMsg.messages, assistantMsg]
        });
      } else if (mode === 'image' && !user) {
         alert("توليد الصور متاح فقط للمستخدمين المسجلين.");
         setShowAuthModal(true);
         setIsGenerating(false);
         return;
      } else {
        const stream = await getSorResponseStream(
            updatedSessionWithUserMsg.messages, 
            text, 
            mode === 'search',
            fileData
        );
        
        let fullContent = '';
        let assistantMsgId = generateUUID();
        
        for await (const chunk of stream) {
          fullContent += chunk.text || '';
          const assistantMsg: Message = {
            id: assistantMsgId,
            role: 'assistant',
            content: fullContent,
            timestamp: Date.now(),
            groundingUrls: chunk.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((c: any) => ({
                uri: c.web?.uri,
                title: c.web?.title
            })).filter(Boolean)
          };
          
          setSessions(prev => {
            const index = prev.findIndex(s => s.id === targetSessionId);
            if (index > -1) {
              const newSessions = [...prev];
              newSessions[index] = {
                ...updatedSessionWithUserMsg,
                messages: [...updatedSessionWithUserMsg.messages, assistantMsg]
              };
              return newSessions;
            }
            return prev;
          });
        }
        
        const finalAssistantMsg: Message = {
          id: assistantMsgId,
          role: 'assistant',
          content: fullContent,
          timestamp: Date.now()
        };
        await updateSessionState({
          ...updatedSessionWithUserMsg,
          messages: [...updatedSessionWithUserMsg.messages, finalAssistantMsg]
        });
      }

      if (user) {
        if (user.plan !== 'unlimited') {
          const updatedUser = { ...user, points: user.points - (mode === 'image' ? 20 : (fileData ? 10 : 5)) };
          setUser(updatedUser);
          await Storage.saveUser(updatedUser);
        }
      } else {
        setGuestUsed(true);
        localStorage.setItem('sor_guest_used', 'true');
      }

    } catch (error) {
      console.error(error);
      alert("حدث خطأ، يرجى المحاولة لاحقاً.");
    } finally {
      setIsGenerating(false);
    }
  };

  const updateSessionState = async (updatedSession: ChatSession) => {
    setSessions(prev => {
        const index = prev.findIndex(s => s.id === updatedSession.id);
        if (index > -1) {
            const newSessions = [...prev];
            newSessions[index] = updatedSession;
            return newSessions;
        }
        return [updatedSession, ...prev];
    });
    if (user) await Storage.saveSession(updatedSession);
  };

  return (
    <div className="flex h-screen bg-[#0d0d0d] text-[#ececec] font-['Noto_Sans_Arabic'] overflow-hidden" dir="rtl">
      {isSidebarOpen && window.innerWidth <= 768 && (
        <div className="fixed inset-0 bg-black/60 z-[100] backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />
      )}

      <Sidebar 
        isOpen={isSidebarOpen} 
        onClose={() => setIsSidebarOpen(false)}
        sessions={user ? sessions : []}
        currentSessionId={currentSessionId}
        onNewChat={() => { 
          setCurrentSessionId(null); 
          setMode('chat'); 
          if(window.innerWidth <= 768) setIsSidebarOpen(false);
        }}
        onSelectSession={(id) => {
          setCurrentSessionId(id);
          if(window.innerWidth <= 768) setIsSidebarOpen(false);
        }}
        user={user}
        onOpenSubscription={() => user ? setIsSubModalOpen(true) : setShowAuthModal(true)}
      />

      <main className="flex-1 flex flex-col relative overflow-hidden h-full">
        <header className="h-16 flex items-center justify-between px-4 md:px-6 border-b border-[#1f1f1f] bg-[#0d0d0d]/80 backdrop-blur-md z-[60] flex-shrink-0">
          <div className="flex items-center gap-2 md:gap-4">
            {!isSidebarOpen && (
              <button onClick={() => setIsSidebarOpen(true)} className="p-2 hover:bg-[#2f2f2f] rounded-xl transition-colors">
                <Menu className="w-5 h-5"/>
              </button>
            )}
            
            <div className="flex items-center gap-1.5 md:gap-2 mr-1">
              <div className="w-7 h-7 md:w-8 md:h-8 rounded-lg bg-gradient-to-br from-[#1b95e0] to-[#ab7fe6] flex items-center justify-center shadow-lg shadow-blue-500/10">
                <span className="text-white font-black text-[10px] md:text-xs">S</span>
              </div>
              <span className="text-lg md:text-xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-white to-[#ab7fe6]">SOR</span>
            </div>

            <div className="flex bg-[#171717] rounded-xl p-0.5 gap-0.5 border border-[#2f2f2f] hidden sm:flex">
                {(['chat', 'image', 'search'] as const).map(m => (
                    <button 
                        key={m}
                        onClick={() => setMode(m)}
                        className={`px-3 md:px-5 py-1.5 rounded-lg text-[10px] md:text-xs font-bold transition-all ${mode === m ? 'bg-[#2f2f2f] text-white shadow-lg' : 'text-[#676767] hover:text-[#ececec]'}`}
                    >
                        {m === 'chat' ? 'الدردشة' : m === 'image' ? 'الصور' : 'البحث'}
                    </button>
                ))}
            </div>
          </div>
          
          <div className="flex items-center gap-2 md:gap-4">
             {user ? (
               <div className="flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-1.5 bg-[#ab7fe6]/10 border border-[#ab7fe6]/20 rounded-full text-[10px] md:text-xs">
                  <Sparkles className="w-3 h-3 text-[#ab7fe6]" />
                  <span className="text-[#ab7fe6] font-black">{user.plan === 'unlimited' ? '∞' : user.points}</span>
                  <span className="text-[#676767] hidden xs:inline">نقطة</span>
               </div>
             ) : (
               <button 
                onClick={() => setShowAuthModal(true)}
                className="bg-white text-black text-[10px] md:text-xs font-black px-3 md:px-4 py-1.5 md:py-2 rounded-xl hover:bg-opacity-90 transition-all shadow-lg"
               >
                 دخول SOR
               </button>
             )}
             
             {user && (
               <div className="relative" ref={userMenuRef}>
                  <button 
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className={`h-9 md:h-10 px-3 md:px-4 rounded-xl bg-[#171717] border flex items-center justify-center transition-all gap-2 ${showUserMenu ? 'border-[#ab7fe6] shadow-[0_0_10px_rgba(171,127,230,0.2)]' : 'border-[#2f2f2f] hover:border-[#444]'}`}
                  >
                      <span className="text-[10px] md:text-xs font-black text-[#ab7fe6]">SOR</span>
                      <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
                  </button>
                  
                  {showUserMenu && (
                    <div className="absolute left-0 top-12 w-48 md:w-56 bg-[#171717] border border-[#2f2f2f] rounded-2xl shadow-2xl z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2">
                        <div className="px-4 py-3 border-b border-[#2f2f2f] bg-[#111]">
                          <p className="text-[10px] text-[#676767] font-bold uppercase">المستخدم</p>
                          <p className="text-sm font-bold truncate text-[#ab7fe6]">{user.username}</p>
                        </div>
                        <button onClick={handleLogout} className="w-full text-right px-4 py-4 text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-3 transition-colors">
                            <LogOut className="w-4 h-4" /> تسجيل الخروج
                        </button>
                    </div>
                  )}
               </div>
             )}
          </div>
        </header>

        <ChatArea 
          session={sessions.find(s => s.id === currentSessionId)} 
          isGenerating={isGenerating}
          onSendMessage={handleSendMessage}
          mode={mode}
          isGuest={!user}
          guestUsed={guestUsed}
        />

        <SubscriptionModal 
          isOpen={isSubModalOpen} 
          onClose={() => setIsSubModalOpen(false)}
          onUpgrade={handleUpgrade}
        />

        {showAuthModal && (
          <Auth 
            onLogin={async (u) => {
              setUser(u);
              Storage.setCurrentUser(u);
              const userSessions = await Storage.getSessions(u.id);
              setSessions(userSessions);
              setShowAuthModal(false);
            }} 
            onClose={() => setShowAuthModal(false)}
          />
        )}
      </main>
    </div>
  );
};

export default App;
