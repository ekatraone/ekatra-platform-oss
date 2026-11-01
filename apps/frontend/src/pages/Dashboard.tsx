
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Sidebar from "@/components/dashboard/Sidebar";
import Stats from "@/components/dashboard/Stats";
import CoursesList from "@/components/dashboard/CoursesList";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpen, MessageCircle, Users } from "lucide-react";
import { apiClient } from "@/services/apiClient";
import { useAuth } from "@/components/AuthProvider";
import { fetchCourses } from "@/lib/api";

const Dashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => {
      const res = await apiClient.getStats();
      return res.data;
    },
    staleTime: 60_000,
  });

  const { data: courses = [], isLoading: coursesLoading } = useQuery({
    queryKey: ['courses'],
    queryFn: fetchCourses,
    staleTime: 60_000,
  });

  const stats = statsData ? [
    { name: "Total Learners", value: String(statsData.totalUsers ?? 0), change: "", trend: "up" as const },
    { name: "Active Courses", value: String(statsData.activeCourses ?? 0), change: "", trend: "up" as const },
    { name: "Completion Rate", value: `${statsData.completionRate ?? 0}%`, change: "", trend: statsData.completionRate >= 70 ? "up" as const : "down" as const },
    { name: "Messages Sent", value: String(statsData.messagesSent ?? 0), change: "", trend: "up" as const },
  ] : [];

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto py-6 px-4 md:px-6">
          <header className="mb-6">
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground">
              Welcome back{user?.name ? `, ${user.name}` : ''}. Here's what's happening.
            </p>
          </header>

          {statsLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </div>
          ) : (
            <Stats stats={stats} />
          )}

          <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2 animate-fade-in" style={{ animationDelay: "0.2s" }}>
              <CardHeader>
                <CardTitle>Recent Courses</CardTitle>
                <CardDescription>
                  Your most recently created courses
                </CardDescription>
              </CardHeader>
              <CardContent>
                {coursesLoading ? (
                  <div className="space-y-3">
                    {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}
                  </div>
                ) : (
                  <CoursesList courses={courses.slice(0, 3)} />
                )}
              </CardContent>
            </Card>

            <Card className="animate-fade-in" style={{ animationDelay: "0.3s" }}>
              <CardHeader>
                <CardTitle>Quick Actions</CardTitle>
                <CardDescription>
                  Frequently used operations
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <button
                    className="flex items-center w-full p-4 rounded-lg border border-border hover:bg-accent/50 transition-colors"
                    onClick={() => navigate('/courses')}
                  >
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mr-4">
                      <BookOpen size={20} className="text-primary" />
                    </div>
                    <div className="text-left">
                      <h3 className="font-medium">New Course</h3>
                      <p className="text-sm text-muted-foreground">
                        Create a new learning course
                      </p>
                    </div>
                  </button>

                  <button
                    className="flex items-center w-full p-4 rounded-lg border border-border hover:bg-accent/50 transition-colors"
                    onClick={() => navigate('/users')}
                  >
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mr-4">
                      <Users size={20} className="text-primary" />
                    </div>
                    <div className="text-left">
                      <h3 className="font-medium">Manage Users</h3>
                      <p className="text-sm text-muted-foreground">
                        View and invite users
                      </p>
                    </div>
                  </button>

                  <button
                    className="flex items-center w-full p-4 rounded-lg border border-border hover:bg-accent/50 transition-colors"
                    onClick={() => navigate('/whatsapp')}
                  >
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mr-4">
                      <MessageCircle size={20} className="text-primary" />
                    </div>
                    <div className="text-left">
                      <h3 className="font-medium">WhatsApp</h3>
                      <p className="text-sm text-muted-foreground">
                        View learner conversations
                      </p>
                    </div>
                  </button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
