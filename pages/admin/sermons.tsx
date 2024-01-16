import AdminLayout from '../../layout/adminLayout';
import SearchableAdminSermonList from '../../components/SearchableAdminSermonsList';
import BottomAudioBar from '../../components/BottomAudioBar';

const AdminSermons = () => {
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
