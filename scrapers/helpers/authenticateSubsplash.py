import requests
import os
from dotenv import load_dotenv

def authenticateSubsplash():
    dirname = os.path.dirname(__file__)
    env_file_path = os.path.join(dirname, '../../functions/.env')
    
    load_dotenv(env_file_path)
    """Authenticate to Subsplash API"""
    # Get the API key

    subsplash_email = os.environ.get('EMAIL')
    subsplash_password = os.environ.get('PASSWORD')
    url = "https://core.subsplash.com/accounts/v1/oauth/token?grant_type=password"

    payload={'grant_type': 'password',
    'scope': 'app:9XTSHD',
    'email': subsplash_email,
    'password': subsplash_password}
    headers = {
      'grant_type': 'password',
      'scope': '9XTSHD'
    }

    response = requests.request("POST", url, headers=headers, data=payload)
    access_token = response.json()['access_token']
    return access_token
  
