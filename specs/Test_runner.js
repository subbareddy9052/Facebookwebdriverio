// const Login=require('../Test/Login');
const Login=require('../Test/Pages/Login');
const Elemntaction=require('../Test/Pages/Element_Actions');
// const basee=require('../Test/base');
const Homepagee=require('../Test/Pages/Homepage');
const Logouut=require('../Test/Pages/Logout')
const Delete_grouppage=require('../Test/Pages/Delete_group')
const siteCredentials=require('../utils/utils')
// const Takescreenshot=require('../Test/Pages/Screenshot')
describe("Test using Webdriverio", function(){

    it("Log into appplication",function(){
    try{
    browser.url('https://www.facebook.com/');
    browser.maximizeWindow()
    browser.pause(5000)

    Login.usernamee.setValue(siteCredentials.username)
    Login.passwordd.setValue(siteCredentials.password)
    browser.pause(3000);
    Login.login_button.click();
    browser.pause(2000);
     Homepagee.more.click();
    browser.pause(5000);
    Homepagee.Groups.click();
      browser.pause(3000);
    Homepagee.Create.click();
     browser.pause(5000);
    Homepagee.Name_Group.setValue('Welcome To Group');
    browser.pause(5000);
    Homepagee.add_Members.setValue(siteCredentials.name);
     browser.pause(5000);
    Homepagee.Add_Groups.click();
    browser.pause(5000);
    
    Homepagee.Create_group.click();
     browser.pause(6000);
    Logouut.Logout.click();
    browser.pause(5000);
    Logouut.Logout_button.click();
    browser.pause(2000);

    }
    catch(err) {
        console.log("Exception is :"+err);
    }
    finally{
        console.log("its always executed.........");
    }

    
    });
});