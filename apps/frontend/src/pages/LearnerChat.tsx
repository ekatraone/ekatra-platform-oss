import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { learnerApi } from '@/services/learnerApi';
import { toast } from 'sonner';

interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  created_at: string;
  status?: string;
}

const LearnerChat = () => {
  const navigate = useNavigate();
  const session = learnerApi.getSession();
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!session?.token) {
      navigate('/learn/login', { replace: true });
      return;
    }

    let active = true;
    (async () => {
      try {
        const [profileRes, messageRes] = await Promise.all([learnerApi.me(), learnerApi.getMessages(80)]);
        if (!active) return;

        const profileName = (profileRes as any)?.data?.name;
        if (profileName && session.learner.name !== profileName) {
          // Keep latest name reflected in the UI session.
          localStorage.setItem('ekatra_learner_auth', JSON.stringify({
            ...session,
            learner: { ...session.learner, name: profileName },
          }));
        }

        setMessages((messageRes as any)?.data || []);
      } catch (err: any) {
        toast.error(err?.message || 'Failed to load learner chat');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [navigate, session]);

  const handleLogout = () => {
    learnerApi.clearSession();
    navigate('/learn/login', { replace: true });
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;

    setSending(true);
    setDraft('');
    try {
      const response = await learnerApi.sendMessage(text);
      setMessages((response as any)?.data || []);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to send message');
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  const learnerName = useMemo(
    () => session?.learner?.name || session?.learner?.phone || 'Learner',
    [session],
  );

  if (!session?.token) return null;

  return (
    <div className="min-h-screen bg-muted/20 px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Welcome, {learnerName}</CardTitle>
              <CardDescription>Web learner channel powered by the same backend FSM.</CardDescription>
            </div>
            <Button variant="outline" onClick={handleLogout}>Logout</Button>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Learning Chat</CardTitle>
            <CardDescription>Send a message to continue your learning flow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="h-[420px] overflow-y-auto rounded-lg border bg-background p-4 space-y-3">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading chat...</p>
              ) : messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No messages yet. Say hello to begin.</p>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === 'inbound' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.direction === 'inbound' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                      <p className="whitespace-pre-wrap">{m.content || '[empty]'}</p>
                      <p className="mt-1 text-[11px] opacity-70">{new Date(m.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSend} className="flex gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type your message..."
              />
              <Button type="submit" disabled={sending}>{sending ? 'Sending...' : 'Send'}</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LearnerChat;
