import { GetServerSideProps, GetServerSidePropsContext, InferGetServerSidePropsType, NextPage } from 'next';
import { useState } from 'react';
import { functions } from '../firebase/firebase';
import { httpsCallable } from 'firebase/functions';
import { ROLES } from '../context/types';
import ProtectedRoute from '../components/ProtectedRoute';

const Admin: NextPage = (props: InferGetServerSidePropsType<typeof getServerSideProps>) => {
  const [email, setEmail] = useState<string>('');
  const [role, setRole] = useState<string>(ROLES[0]);
  const [message, setMessage] = useState<string>('');

  const setUserRole = httpsCallable(functions, 'setUserRole');
  const handleSubmit = () => {
    setUserRole({ email, role }).then((result: any) => {
      setMessage(result.data.status);
    });
  };

  return (
    <div>
      <h1>admin page</h1>
      <input placeholder="User Email" value={email} onChange={(e) => setEmail(e.target.value.toLowerCase())} />
      <select onChange={(e) => setRole(e.target.value)} value={role} defaultValue={ROLES[0]}>
        {ROLES.map((role) => (
          <option value={role} key={role}>
            {role}
          </option>
        ))}
      </select>
      <button onClick={handleSubmit}>submit</button>
      {message}
    </div>
  );
};

export default Admin;

export const getServerSideProps: GetServerSideProps = async (ctx: GetServerSidePropsContext) => {
  const userCredentials = await ProtectedRoute(ctx);
  if (!userCredentials.props.uid || userCredentials.props.customClaims?.role !== 'admin') {
    return {
      redirect: {
        permanent: false,
        destination: '/',
      },
      props: {},
    };
  }
  return { props: {} };
};
