import AdminLayoutComponent from './AdminLayoutComponent';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminLayoutComponent>{children}</AdminLayoutComponent>;
}
