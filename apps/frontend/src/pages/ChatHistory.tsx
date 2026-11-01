
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Sidebar from "@/components/dashboard/Sidebar";
import ListPager from "@/components/dashboard/ListPager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, MessageSquare, Send, Loader2, BookOpen } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/services/apiClient";
import { fetchAllCourseRecords } from "@/lib/api";
import { useLearnerChat } from "@/hooks/useChatHistory";
import { usePagedLearners } from "@/hooks/usePagedLearners";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";

// Rows from GET /api/learners. Telegram learners are stored with phone "tg:<chat_id>".
interface ChatLearner {
  id: string;
  name?: string | null;
  phone: string;
  created_at?: string;
  updated_at?: string;
}

type Platform = "whatsapp" | "telegram";

const platformOf = (l: ChatLearner): Platform => ((l.phone || "").startsWith("tg:") ? "telegram" : "whatsapp");
const handleOf = (l: ChatLearner) => (platformOf(l) === "telegram" ? `Telegram ${l.phone.slice(3)}` : l.phone);
const titleOf = (l: ChatLearner) => l.name || handleOf(l);
const formatDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : "—");

const ChatHistory = () => {
  const { toast } = useToast();
  const [selectedPlatform, setSelectedPlatform] = useState<"all" | Platform>("all");
  const [selectedChat, setSelectedChat] = useState<ChatLearner | null>(null);
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<ChatLearner | null>(null);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [isEnrolling, setIsEnrolling] = useState(false);

  // Course picker needs every published course, not just the first page.
  const { data: coursesData } = useQuery({
    queryKey: ['courses', 'published-picker'],
    queryFn: () => fetchAllCourseRecords({ status: 'published' }),
  });

  // One server-side page of learners; search runs on the server across all learners.
  const {
    learners, pagination, loading, fetching, error: learnersError,
    search: searchQuery, setSearch: setSearchQuery, setPage,
  } = usePagedLearners<ChatLearner>();

  const {
    messages,
    isLoading: loadingMessages,
    error: messagesError,
    sendMessage,
  } = useLearnerChat(selectedChat?.id);

  const handleOpenEnroll = (e: React.MouseEvent, chat: ChatLearner) => {
    e.stopPropagation();
    setEnrollTarget(chat);
    setSelectedCourseId("");
    setEnrollModalOpen(true);
  };

  const handleEnroll = async () => {
    if (!enrollTarget || !selectedCourseId) return;
    setIsEnrolling(true);
    try {
      await apiClient.enrollLearner(enrollTarget.id, selectedCourseId, true);
      toast({ title: "Enrolled", description: `Learner enrolled and Day 1 will be sent shortly.` });
      setEnrollModalOpen(false);
    } catch (err: any) {
      toast({ title: "Enroll failed", description: err.message, variant: "destructive" });
    } finally {
      setIsEnrolling(false);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedChat || isSending) return;
    setIsSending(true);
    try {
      await sendMessage(newMessage);
      toast({
        title: "Message sent",
        description: `Your ${platformOf(selectedChat) === "telegram" ? "Telegram" : "WhatsApp"} message has been sent`,
      });
      setNewMessage("");
    } catch (error) {
      // Keep the typed text so the admin can retry.
      toast({
        title: "Error sending message",
        description: (error as Error).message || "There was a problem sending your message",
        variant: "destructive"
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleOpenChat = (chat: ChatLearner) => {
    setSelectedChat(chat);
    setNewMessage("");
    setChatModalOpen(true);
  };

  // Platform tabs filter the current page; search and paging happen on the server.
  const chatsFor = (platform: "all" | Platform) =>
    platform === "all" ? learners : learners.filter((l) => platformOf(l) === platform);

  const renderList = (platform: "all" | Platform) => {
    const chats = chatsFor(platform);
    return (
      <>
        {chats.map((chat) => (
          <Card key={chat.id} className="p-4 hover:bg-accent/50 transition-colors cursor-pointer" onClick={() => handleOpenChat(chat)}>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium flex items-center gap-2">
                  {titleOf(chat)}
                  <Badge variant="outline" className="ml-2">
                    {platformOf(chat) === "telegram" ? 'Telegram' : 'WhatsApp'}
                  </Badge>
                </h3>
                <p className="text-sm text-muted-foreground">
                  {chat.name ? `${handleOf(chat)} · ` : ""}Last updated: {formatDate(chat.updated_at || chat.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" title="Enroll in course" onClick={(e) => handleOpenEnroll(e, chat)}>
                  <BookOpen className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon">
                  <MessageSquare className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>
        ))}

        {chats.length === 0 && !loading && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">
              {learnersError ? `Failed to load conversations: ${learnersError.message}` : "No conversations found"}
            </p>
          </div>
        )}

        {loading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        )}

        <ListPager pagination={pagination} onPageChange={setPage} disabled={fetching} />
      </>
    );
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto py-6 px-4 md:px-6">
          <header className="mb-6">
            <h1 className="text-2xl font-bold">Chat History</h1>
            <p className="text-muted-foreground">
              View and manage student conversations across platforms
            </p>
          </header>

          <div className="mb-6">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or phone..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>

          <Tabs defaultValue="all" onValueChange={(value) => setSelectedPlatform(value as any)}>
            <TabsList>
              <TabsTrigger value="all">All Platforms</TabsTrigger>
              <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
              <TabsTrigger value="telegram">Telegram</TabsTrigger>
            </TabsList>

            <TabsContent value="all" className="space-y-4 mt-4">
              {selectedPlatform === "all" && renderList("all")}
            </TabsContent>
            <TabsContent value="whatsapp" className="space-y-4 mt-4">
              {selectedPlatform === "whatsapp" && renderList("whatsapp")}
            </TabsContent>
            <TabsContent value="telegram" className="space-y-4 mt-4">
              {selectedPlatform === "telegram" && renderList("telegram")}
            </TabsContent>
          </Tabs>
        </div>
      </main>

      {/* Chat Dialog */}
      <Dialog open={chatModalOpen} onOpenChange={setChatModalOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedChat && titleOf(selectedChat)}
              <Badge variant="outline">
                {selectedChat && platformOf(selectedChat) === "telegram" ? 'Telegram' : 'WhatsApp'}
              </Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto my-4 p-3 bg-muted/50 rounded-md min-h-[300px] max-h-[400px]">
            {loadingMessages ? (
              <div className="flex justify-center items-center h-full">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : messagesError ? (
              <p className="text-center text-destructive">Failed to load messages: {messagesError.message}</p>
            ) : messages.length > 0 ? (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`mb-2 p-2 rounded-lg ${
                    msg.direction === 'outbound' ? 'ml-auto bg-primary/10' : 'mr-auto bg-secondary/10'
                  } max-w-[80%]`}
                >
                  <p className="text-sm">{msg.content || `[${msg.message_type}]`}</p>
                  <span className="text-xs text-muted-foreground">
                    {new Date(msg.created_at).toLocaleString()}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-center text-muted-foreground">No messages to display</p>
            )}
          </div>

          <div className="flex gap-2">
            <Textarea
              placeholder="Type your message..."
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              className="resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
            />
            <Button onClick={handleSendMessage} type="submit" disabled={isSending || !newMessage.trim()}>
              {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Enroll in Course Dialog */}
      <Dialog open={enrollModalOpen} onOpenChange={setEnrollModalOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Enroll in Course</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Learner: <span className="font-medium">{enrollTarget && titleOf(enrollTarget)}</span>
            </p>
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Course</label>
              <Select value={selectedCourseId} onValueChange={setSelectedCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a course..." />
                </SelectTrigger>
                <SelectContent>
                  {(coursesData || []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEnrollModalOpen(false)}>Cancel</Button>
              <Button onClick={handleEnroll} disabled={!selectedCourseId || isEnrolling}>
                {isEnrolling ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Enroll &amp; Send Day 1
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ChatHistory;
