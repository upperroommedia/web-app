/**
 * About page for information about Upper Room Media
 */
import type { NextPage } from 'next';
import useAuth from '../context/user/UserContext';
import styles from '../styles/Home.module.css';

const Profile: NextPage = () => {
  const { user } = useAuth();
  if (user) {
    return (
      <div className={styles.container}>
        <h1>Profile</h1>
        <p>First Name: {user?.firstName}</p>
        <p>Last Name: {user?.lastName}</p>
      </div>
    );
  } else {
    return null;
  }
};

export default Profile;
