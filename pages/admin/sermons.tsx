import AdminLayout from '../../layout/adminLayout';
// import { adminProtected } from '../../utils/protectedRoutes';
// import { GetServerSideProps, GetServerSidePropsContext } from 'next';
// import AdminSermonsList from '../../components/AdminSermonsList';
import SearchableAdminSermonList from '../../components/SearchableAdminSermonsList';
import BottomAudioBar from '../../components/BottomAudioBar';

const AdminSermons = () => {
  // return <AdminSermonsList collectionPath="sermons" />;
  return (
    <>
      <SearchableAdminSermonList />;
      <BottomAudioBar />
    </>
  );
};

AdminSermons.PageLayout = AdminLayout;

// export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
//   return adminProtected(ctx);
//   // TODO: see if you can get sermons server side then attach a listener on the client
// };

export default AdminSermons;
