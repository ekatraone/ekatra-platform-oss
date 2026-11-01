
import { useEffect, useState } from "react";
import Sidebar from "@/components/dashboard/Sidebar";
import UsersList from "@/components/dashboard/UsersList";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { apiClient } from "@/services/apiClient";
import { RequireRole } from "@/components/AuthProvider";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Map raw backend user → AppUser shape expected by UsersList
const toAppUser = (u: any, idx: number) => ({
  id: u.id,
  _backendId: u.id,
  name: u.name || u.email.split('@')[0],
  email: u.email,
  role: u.role,
  courses: 0,
  joined: u.created_at?.split('T')[0] || '',
  status: 'active' as const,
});

const Users = () => {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Temporary password returned once by POST /api/users — shown to the admin a single time,
  // held only in memory, never logged or persisted.
  const [invite, setInvite] = useState<{ email: string; password: string } | null>(null);
  const { toast } = useToast();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/api/users') as any;
      setUsers((res?.data || []).map(toAppUser));
    } catch (err: any) {
      toast({ title: "Error loading users", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); }, []);

  const addUser = async (data: any) => {
    let res: any;
    try {
      res = await apiClient.post('/api/users', { email: data.email, name: data.name, role: data.role });
    } catch (err: any) {
      toast({ title: "Invite failed", description: err.message, variant: "destructive" });
      throw err;
    }
    if (typeof res?.temporaryPassword === 'string') {
      setInvite({ email: data.email, password: res.temporaryPassword });
    } else {
      toast({ title: "User invited", description: `${data.email} has been added.` });
    }
    fetchUsers();
  };

  const updateUser = async (userId: string, updates: any) => {
    const backendId = users.find(u => u.id === userId)?._backendId;
    if (!backendId) return;
    await apiClient.put(`/api/users/${backendId}`, updates);
    toast({ title: "User updated" });
    fetchUsers();
  };

  const deleteUser = async (userId: string) => {
    const backendId = users.find(u => u.id === userId)?._backendId;
    if (!backendId) return;
    await apiClient.delete(`/api/users/${backendId}`);
    toast({ title: "User deleted" });
    setUsers(u => u.filter(x => x.id !== userId));
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto py-6 px-4 md:px-6">
          <header className="mb-6">
            <h1 className="text-2xl font-bold">User Management</h1>
            <p className="text-muted-foreground">
              Manage platform admins and viewers
            </p>
          </header>

          <RequireRole roles="admin" fallback={
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Admin Access Required</AlertTitle>
              <AlertDescription>You need admin or super_admin role to manage users.</AlertDescription>
            </Alert>
          }>
            {loading ? (
              <div className="flex justify-center items-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : (
              <UsersList
                users={users}
                onAddUser={addUser}
                onUpdateUser={updateUser}
                onDeleteUser={deleteUser}
              />
            )}
          </RequireRole>
        </div>
      </main>

      {/* One-time temporary password for a newly invited user */}
      <Dialog open={!!invite} onOpenChange={(open) => { if (!open) setInvite(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>User invited</DialogTitle>
            <DialogDescription>
              Share this temporary password with {invite?.email} over a secure channel.
              It is shown only once and cannot be retrieved after you close this dialog.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={invite?.password ?? ''} className="font-mono" onFocus={(e) => e.target.select()} />
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                if (!invite) return;
                try {
                  await navigator.clipboard.writeText(invite.password);
                  toast({ title: "Copied", description: "Temporary password copied to clipboard." });
                } catch {
                  toast({ title: "Copy failed", description: "Select the password and copy it manually.", variant: "destructive" });
                }
              }}
            >
              <Copy className="h-4 w-4 mr-1" /> Copy
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setInvite(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Users;
