import Typography from '@mui/material/Typography';
import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import AdminLayout from '../../layout/adminLayout';
import { adminProtected } from '../../utils/protectedRoutes';

const AdminTopics = () => {
  return <Typography variant="h2">Manage Topics</Typography>;
};

AdminTopics.PageLayout = AdminLayout;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  return adminProtected(ctx);
};

export default AdminTopics;
