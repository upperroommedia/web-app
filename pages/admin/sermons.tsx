import AdminLayout from '../../layout/adminLayout';
// import { adminProtected } from '../../utils/protectedRoutes';
// import { GetServerSideProps, GetServerSidePropsContext } from 'next';
import AdminSermonsList from '../../components/AdminSermonsList';
import Box from '@mui/system/Box';
import { useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { reviewStatusType } from '../../types/SermonTypes';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index } = props;

  return <div>{value === index && <Box sx={{ p: 3 }}>{children}</Box>}</div>;
}

const AdminSermons = () => {
  const [tab, setTab] = useState(0);

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    setTab(newValue);
  };

  return (
    <Box>
      <Tabs value={tab} onChange={handleChange} aria-label="basic tabs example">
        <Tab label="Approved Sermons" />
        <Tab label="Needs Review" />
      </Tabs>
      <TabPanel value={tab} index={0}>
        <AdminSermonsList collectionPath="sermons" reviewStatus={reviewStatusType.APPROVED} />
      </TabPanel>
      <TabPanel value={tab} index={1}>
        <AdminSermonsList collectionPath="sermons" reviewStatus={reviewStatusType.IN_REVIEW} />
      </TabPanel>
    </Box>
  );
};

AdminSermons.PageLayout = AdminLayout;

// export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
//   return adminProtected(ctx);
//   // TODO: see if you can get sermons server side then attach a listener on the client
// };

export default AdminSermons;
